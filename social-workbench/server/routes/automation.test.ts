import { createTestContext } from '../test/helpers';
import { all, get } from '../db';
import { mockProvider } from '../ai/mockProvider';
import { forceHumanReasons } from '../ai/safety';

async function analyzeReasons(body: string, rating: number | null = null) {
  const a = await mockProvider.analyze({ body, authorName: 'x', rating, platform: 'facebook', brandCode: 'BA' });
  return { a, codes: forceHumanReasons(a).map((r) => r.code) };
}

describe('安全檢查（不可妥協）', () => {
  it('單純稱讚可以自動回覆', async () => {
    const { a, codes } = await analyzeReasons('好喝！超讚 👍');
    expect(a.categoryKey).toBe('praise');
    expect(codes).toEqual([]);
  });

  it.each([
    ['客訴', '用一個月就漏水，品質到底怎樣', 'complaint'],
    ['退款', '東西很好喝，但我想退款', 'refund'],
    ['補償', '等了兩週才到，要不要補償一下', 'refund'],
    ['敏感議題', '奶瓶用熱水消毒會不會有塑化劑？', 'sensitive'],
    ['無法確認的承諾', '很喜歡！可以保證明天到貨嗎', 'promise'],
    ['知識不足', '這個多少錢？', 'knowledge_gap'],
    ['問題不明確', '請問那個東西還有嗎', 'ambiguous'],
    ['低星評論', '還可以', 'risk'],
  ])('%s → 一律轉人工', async (_label, body, code) => {
    const { codes } = await analyzeReasons(body, _label === '低星評論' ? 1 : null);
    expect(codes).toContain(code);
  });

  it('稱讚夾帶負面字眼不算稱讚', async () => {
    const { a, codes } = await analyzeReasons('以前很好喝，這次很失望');
    expect(a.categoryKey).not.toBe('praise');
    expect(codes.length).toBeGreaterThan(0);
  });
});

describe('自動回覆規則 API', () => {
  async function createRule(ctx: Awaited<ReturnType<typeof createTestContext>>, extra: Record<string, unknown> = {}) {
    const admin = await ctx.loginAs('admin');
    return admin.post('/api/automation/rules').send({
      brandId: ctx.fx.brandA,
      name: '稱讚自動感謝',
      action: 'auto_reply',
      categories: ['praise'],
      platforms: [],
      minConfidence: 0.85,
      isActive: true,
      ...extra,
    });
  }

  it('管理員可新增規則並留下操作紀錄', async () => {
    const ctx = await createTestContext();
    const res = await createRule(ctx);
    expect(res.status).toBe(201);
    expect(res.body.categories).toEqual(['praise']);
    const logs = await all(ctx.db, "SELECT * FROM audit_logs WHERE action = 'automation.rule_create'");
    expect(logs).toHaveLength(1);
  });

  it('自動回覆不可設定在客訴、價格等類型', async () => {
    const ctx = await createTestContext();
    const res = await createRule(ctx, { categories: ['complaint'] });
    expect(res.status).toBe(400);
    expect((await createRule(ctx, { categories: ['price_inquiry'] })).status).toBe(400);
  });

  it('信心門檻不可低於系統下限', async () => {
    const ctx = await createTestContext();
    expect((await createRule(ctx, { minConfidence: 0.5 })).status).toBe(400);
  });

  it('主管只能查看與測試，不能新增；操作人員不能使用', async () => {
    const ctx = await createTestContext();
    const sup = await ctx.loginAs('sup');
    expect((await sup.get('/api/automation/rules')).status).toBe(200);
    expect((await sup.post('/api/automation/rules').send({})).status).toBe(403);
    const op = await ctx.loginAs('opA');
    expect((await op.get('/api/automation/rules')).status).toBe(403);
  });

  it('主管不能看到其他品牌的規則或用其他品牌測試', async () => {
    const ctx = await createTestContext();
    await createRule(ctx, { brandId: ctx.fx.brandB });
    const sup = await ctx.loginAs('sup');
    expect((await sup.get('/api/automation/rules')).body.rules).toHaveLength(0);
    const res = await sup.post('/api/automation/test').send({ brandId: ctx.fx.brandB, platform: 'facebook', body: '好喝' });
    expect(res.status).toBe(403);
  });

  it('測試工具：顯示判斷結果與自動回覆內容，且不寫入資料庫', async () => {
    const ctx = await createTestContext();
    await createRule(ctx);
    const admin = await ctx.loginAs('admin');
    const before = (await get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM comments'))!.n;
    const ok = await admin.post('/api/automation/test').send({ brandId: ctx.fx.brandA, platform: 'facebook', body: '超好用，謝謝你們！' });
    expect(ok.body.decision).toBe('auto_replied');
    expect(ok.body.replyBody).toBeTruthy();
    const blocked = await admin.post('/api/automation/test').send({ brandId: ctx.fx.brandA, platform: 'facebook', body: '很好用，但我要退款' });
    expect(blocked.body.decision).toBe('human');
    expect(blocked.body.forceHuman.map((r: { code: string }) => r.code)).toContain('refund');
    expect((await get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM comments'))!.n).toBe(before);
  });

  it('模擬收到稱讚：AI 自動回覆、狀態已完成、紀錄執行者為規則', async () => {
    const ctx = await createTestContext();
    const rule = await createRule(ctx);
    const admin = await ctx.loginAs('admin');
    const res = await admin.post('/api/automation/simulate').send({ postId: ctx.fx.postA, authorName: '小魚', body: '咖啡超好喝！回購了 👍' });
    expect(res.status).toBe(201);
    expect(res.body.decision).toBe('auto_replied');
    const c = (await get<{ status: string; is_auto_handled: number; first_response_type: string; first_response_at: string | null }>(
      ctx.db,
      'SELECT status, is_auto_handled, first_response_type, first_response_at FROM comments WHERE id = ?',
      [res.body.commentId],
    ))!;
    expect(c).toMatchObject({ status: 'done', is_auto_handled: 1, first_response_type: 'ai_auto' });
    expect(c.first_response_at).not.toBeNull();
    const reply = (await get<{ source: string; rule_id: number; sent_by_id: number | null }>(ctx.db, 'SELECT source, rule_id, sent_by_id FROM replies WHERE comment_id = ?', [res.body.commentId]))!;
    expect(reply).toMatchObject({ source: 'auto_rule', rule_id: rule.body.id, sent_by_id: null });
    const log = await get<{ actor_type: string; rule_id: number }>(ctx.db, "SELECT actor_type, rule_id FROM audit_logs WHERE action = 'comment.auto_reply' AND comment_id = ?", [res.body.commentId]);
    expect(log).toMatchObject({ actor_type: 'rule', rule_id: rule.body.id });
    const analysis = await get(ctx.db, 'SELECT * FROM ai_analyses WHERE comment_id = ?', [res.body.commentId]);
    expect(analysis).toBeTruthy();
  });

  it('模擬收到客訴：不自動回覆、標記需人工、啟動時效', async () => {
    const ctx = await createTestContext();
    await createRule(ctx);
    const admin = await ctx.loginAs('admin');
    const res = await admin.post('/api/automation/simulate').send({ postId: ctx.fx.postA, authorName: '阿德', body: '買不到一個月就漏水，到底要怎麼處理？' });
    expect(res.body.decision).toBe('human');
    expect(res.body.slaMinutes).toBe(15);
    const c = (await get<{ status: string; needs_human: number; sla_due_at: string | null }>(ctx.db, 'SELECT status, needs_human, sla_due_at FROM comments WHERE id = ?', [res.body.commentId]))!;
    expect(c).toMatchObject({ status: 'pending', needs_human: 1 });
    expect(c.sla_due_at).not.toBeNull();
    expect(await get(ctx.db, 'SELECT id FROM replies WHERE comment_id = ?', [res.body.commentId])).toBeUndefined();
  });

  it('停用的規則不會執行', async () => {
    const ctx = await createTestContext();
    await createRule(ctx, { isActive: false });
    const admin = await ctx.loginAs('admin');
    const res = await admin.post('/api/automation/simulate').send({ postId: ctx.fx.postA, authorName: '小魚', body: '好喝！' });
    expect(res.body.decision).toBe('human');
    expect(res.body.matchedRule).toBeNull();
  });

  it('操作人員不能使用模擬器；主管不能模擬其他品牌的貼文', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    expect((await op.post('/api/automation/simulate').send({ postId: ctx.fx.postA, authorName: 'x', body: 'y' })).status).toBe(403);
    const sup = await ctx.loginAs('sup');
    expect((await sup.post('/api/automation/simulate').send({ postId: ctx.fx.postB, authorName: 'x', body: '好喝' })).status).toBe(404);
  });

  it('已執行過的規則刪除時改為停用，保留紀錄的關聯', async () => {
    const ctx = await createTestContext();
    const rule = await createRule(ctx);
    const admin = await ctx.loginAs('admin');
    await admin.post('/api/automation/simulate').send({ postId: ctx.fx.postA, authorName: '小魚', body: '好喝！' });
    expect((await admin.delete(`/api/automation/rules/${rule.body.id}`)).status).toBe(204);
    const row = await get<{ is_active: number }>(ctx.db, 'SELECT is_active FROM automation_rules WHERE id = ?', [rule.body.id]);
    expect(row?.is_active).toBe(0);
  });
});
