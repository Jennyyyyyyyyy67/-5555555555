import { createTestContext } from '../test/helpers';
import { all, get, insert, run } from '../db';
import { nowIso } from '../lib/clock';
import { groupComments, personalize, similarity } from '../ai/grouping';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

async function addKnowledge(ctx: Ctx) {
  const now = nowIso();
  return insert(ctx.db, 'knowledge_items', {
    brand_id: ctx.fx.brandA,
    category: 'price',
    title: '禮盒價格',
    content: '耶誕禮盒早鳥價 1,280 元，11/30 前預購。',
    keywords: ['禮盒', '多少錢', '價格', '售價', '多少'],
    review_status: 'approved',
    created_at: now,
    updated_at: now,
  });
}

async function burst(ctx: Ctx, kind: string, count = 5) {
  const admin = await ctx.loginAs('admin');
  const res = await admin.post('/api/automation/simulate-burst').send({ postId: ctx.fx.postA, kind, count });
  expect(res.status).toBe(201);
  return res.body as { created: number };
}

describe('相似留言分組（模擬 AI）', () => {
  const base = { postId: 1, riskFlags: [], riskLevel: 'none', sentiment: 'neutral' };
  it('不同說法的詢價歸成同一組；客訴不放進任何組', () => {
    const { groups, excludedIds } = groupComments([
      { ...base, id: 1, categoryKey: 'price_inquiry', body: '多少錢？' },
      { ...base, id: 2, categoryKey: 'price_inquiry', body: '價格？' },
      { ...base, id: 3, categoryKey: 'price_inquiry', body: '請問售價' },
      { ...base, id: 4, categoryKey: 'price_inquiry', body: '一組多少？' },
      { ...base, id: 5, categoryKey: 'complaint', body: '多少錢？上次買的漏水了', riskFlags: ['complaint'], sentiment: 'negative' },
      { ...base, id: 6, postId: 2, categoryKey: 'price_inquiry', body: '多少錢' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ intentKey: 'price', ids: [1, 2, 3, 4] });
    expect(excludedIds).toEqual([5]);
  });

  it('沒有對應問題類型時依文字相似度分組', () => {
    expect(similarity('這款適合送長輩嗎', '這款適合送長輩嗎？')).toBeGreaterThan(0.9);
    const { groups } = groupComments([
      { ...base, id: 1, categoryKey: 'other', body: '這款適合送長輩嗎' },
      { ...base, id: 2, categoryKey: 'other', body: '這款適合送長輩嗎？' },
      { ...base, id: 3, categoryKey: 'other', body: '今天天氣真好' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].ids).toEqual([1, 2]);
  });

  it('措辭變化只改開頭稱呼', () => {
    expect(personalize('謝謝詢問！', '小雨', 0)).toBe('小雨 您好～謝謝詢問！');
    expect(personalize('謝謝詢問！', '小雨', 1)).toBe('Hi 小雨，謝謝詢問！');
  });
});

describe('批次處理 API', () => {
  it('大量詢價：分成一組，批次產生回覆（事實一致、措辭不同），每則各自留下紀錄', async () => {
    const ctx = await createTestContext();
    await addKnowledge(ctx);
    await burst(ctx, 'mixed', 6);
    const op = await ctx.loginAs('opA');
    const groups = await op.get('/api/batch/groups');
    expect(groups.status).toBe(200);
    const g = groups.body.groups.find((x: { intentKey: string }) => x.intentKey === 'price');
    expect(g.comments).toHaveLength(5);
    expect(groups.body.individualCount).toBeGreaterThanOrEqual(1);

    const complaint = await get<{ id: number }>(ctx.db, "SELECT id FROM comments WHERE body LIKE '%品質到底怎樣%'");
    const ids = g.comments.map((c: { id: number }) => c.id);
    const sug = await op.post('/api/batch/suggest').send({ commentIds: [...ids, complaint!.id] });
    expect(sug.status).toBe(200);
    expect(sug.body.drafts).toHaveLength(5);
    expect(sug.body.skipped).toEqual([{ commentId: complaint!.id, reason: expect.stringContaining('客訴') }]);
    const bodies: string[] = sug.body.drafts.map((d: { body: string }) => d.body);
    expect(bodies.every((b) => b.includes('1,280 元'))).toBe(true);
    expect(new Set(bodies).size).toBe(bodies.length);
    expect((await all(ctx.db, `SELECT id FROM ai_suggestions WHERE comment_id IN (${ids.join(',')})`)).length).toBe(5);

    const send = await op.post('/api/batch/reply').send({
      batchId: sug.body.batchId,
      statusAfter: 'waiting',
      items: sug.body.drafts.map((d: { commentId: number; body: string; suggestionId: number }) => ({ commentId: d.commentId, body: d.body, suggestionId: d.suggestionId })),
    });
    expect(send.status).toBe(201);
    expect(send.body).toMatchObject({ succeeded: 5, failed: 0 });
    for (const id of ids) {
      const c = await get<{ status: string; first_response_type: string }>(ctx.db, 'SELECT status, first_response_type FROM comments WHERE id = ?', [id]);
      expect(c).toMatchObject({ status: 'waiting', first_response_type: 'human' });
      const reply = await get<{ source: string; sent_by_id: number }>(ctx.db, 'SELECT source, sent_by_id FROM replies WHERE comment_id = ?', [id]);
      expect(reply).toMatchObject({ source: 'ai_adopted', sent_by_id: ctx.fx.opA });
      const log = await get<{ detail: string }>(ctx.db, "SELECT detail FROM audit_logs WHERE action = 'comment.reply' AND comment_id = ?", [id]);
      expect(JSON.parse(log!.detail).batchId).toBe(sug.body.batchId);
    }
    // 回覆過的留言不再出現在分組
    const after = await op.get('/api/batch/groups');
    expect(after.body.groups.find((x: { intentKey: string }) => x.intentKey === 'price')).toBeUndefined();
  });

  it('知識庫查不到時標記知識不足，回覆不含價格', async () => {
    const ctx = await createTestContext();
    await burst(ctx, 'price', 3);
    const op = await ctx.loginAs('opA');
    const ids = (await all<{ id: number }>(ctx.db, "SELECT id FROM comments WHERE external_id LIKE 'sim-%'")).map((x) => x.id);
    const sug = await op.post('/api/batch/suggest').send({ commentIds: ids });
    expect(sug.body.knowledgeGap).toBe(true);
    expect(sug.body.drafts.every((d: { body: string }) => !/\d+\s*元/.test(d.body))).toBe(true);
  });

  it('送出前檢查：查無根據的金額要確認；禁用詞整批擋下', async () => {
    const ctx = await createTestContext();
    await burst(ctx, 'price', 2);
    const op = await ctx.loginAs('opA');
    const ids = (await all<{ id: number }>(ctx.db, "SELECT id FROM comments WHERE external_id LIKE 'sim-%' ORDER BY id")).map((x) => x.id);
    const items = ids.map((id) => ({ commentId: id, body: '只要 999 元喔' }));
    const warn = await op.post('/api/batch/reply').send({ statusAfter: 'waiting', items });
    expect(warn.status).toBe(422);
    expect(warn.body.error.code).toBe('reply_warnings');
    expect(await get(ctx.db, `SELECT id FROM replies WHERE comment_id IN (${ids.join(',')})`)).toBeUndefined();
    const ok = await op.post('/api/batch/reply').send({ statusAfter: 'waiting', confirmWarnings: true, items });
    expect(ok.body.succeeded).toBe(2);
    // 已處理過的再送一次：逐則回報失敗，不會重複回覆
    const again = await op.post('/api/batch/reply').send({ statusAfter: 'done', confirmWarnings: true, items });
    expect(again.body.succeeded).toBe(0);
  });

  it('品牌權限：不能批次處理其他品牌的留言', async () => {
    const ctx = await createTestContext();
    const opB = await ctx.loginAs('opB');
    expect((await opB.post('/api/batch/suggest').send({ commentIds: [ctx.fx.commentA] })).status).toBe(400);
    expect((await opB.post('/api/batch/status').send({ commentIds: [ctx.fx.commentA], status: 'no_action' })).body.failed).toBe(1);
    const admin = await ctx.loginAs('admin');
    expect((await admin.post('/api/batch/suggest').send({ commentIds: [ctx.fx.commentA, ctx.fx.commentB] })).status).toBe(400);
  });

  it('批次標記無需處理：每則各自留下紀錄', async () => {
    const ctx = await createTestContext();
    await burst(ctx, 'interest', 3);
    const op = await ctx.loginAs('opA');
    const ids = (await all<{ id: number }>(ctx.db, "SELECT id FROM comments WHERE external_id LIKE 'sim-%'")).map((x) => x.id);
    const res = await op.post('/api/batch/status').send({ commentIds: ids, status: 'no_action', reason: '+1 留言不需回覆' });
    expect(res.body.succeeded).toBe(3);
    const logs = await all(ctx.db, `SELECT id FROM audit_logs WHERE action = 'comment.status_change' AND comment_id IN (${ids.join(',')})`);
    expect(logs).toHaveLength(3);
  });

  it('真實帳號不能放入模擬留言', async () => {
    const ctx = await createTestContext();
    await run(ctx.db, "INSERT INTO account_credentials (account_id, provider, access_token_enc, platform_user_id, connected_at, updated_at) VALUES (?, 'instagram', 'x', 'x', ?, ?)", [ctx.fx.accountA, nowIso(), nowIso()]);
    const admin = await ctx.loginAs('admin');
    const res = await admin.post('/api/automation/simulate-burst').send({ postId: ctx.fx.postA, kind: 'price', count: 3 });
    expect(res.status).toBe(400);
  });
});

describe('強制轉人工規則與知識庫自動回覆', () => {
  it('品牌自訂關鍵字：一律轉人工、提升為高優先、指派負責人並通知', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    await admin.post('/api/automation/rules').send({ brandId: ctx.fx.brandA, name: '稱讚自動感謝', action: 'auto_reply', categories: ['praise'], platforms: [], minConfidence: 0.85, isActive: true });
    const rule = await admin.post('/api/automation/rules').send({
      brandId: ctx.fx.brandA, name: '法律字眼', action: 'force_human', matchType: 'keyword', keywords: ['律師', '消保官'],
      categories: [], platforms: [], minConfidence: 0.85, raisePriority: true, assigneeId: ctx.fx.sup, isActive: true,
    });
    expect(rule.status).toBe(201);
    expect(rule.body).toMatchObject({ action: 'force_human', assigneeName: '主管' });
    // 負責人必須有品牌權限
    const bad = await admin.post('/api/automation/rules').send({ brandId: ctx.fx.brandA, name: 'x', action: 'force_human', matchType: 'keyword', keywords: ['a'], categories: [], platforms: [], minConfidence: 0.85, assigneeId: ctx.fx.opB });
    expect(bad.status).toBe(400);

    const res = await admin.post('/api/automation/simulate').send({ postId: ctx.fx.postA, authorName: '小魚', body: '超好喝！我朋友是律師也說讚' });
    expect(res.body.decision).toBe('human');
    expect(res.body.forceHuman.map((r: { code: string }) => r.code)).toContain('brand_rule');
    const c = await get<{ priority: string; assignee_id: number; needs_human: number }>(ctx.db, 'SELECT priority, assignee_id, needs_human FROM comments WHERE id = ?', [res.body.commentId]);
    expect(c).toMatchObject({ priority: 'high', assignee_id: ctx.fx.sup, needs_human: 1 });
    expect(await get(ctx.db, "SELECT id FROM notifications WHERE user_id = ? AND comment_id = ?", [ctx.fx.sup, res.body.commentId])).toBeTruthy();
    expect(await get(ctx.db, "SELECT id FROM audit_logs WHERE action = 'comment.force_human' AND comment_id = ?", [res.body.commentId])).toBeTruthy();
    expect(await get(ctx.db, 'SELECT id FROM replies WHERE comment_id = ?', [res.body.commentId])).toBeUndefined();
  });

  it('詢價自動回覆：知識庫沒有答案就轉人工；有答案才引用知識自動回覆', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    await admin.post('/api/automation/rules').send({ brandId: ctx.fx.brandA, name: '詢價自動回覆', action: 'auto_reply', categories: ['price_inquiry'], platforms: [], minConfidence: 0.85, isActive: true });
    const gap = await admin.post('/api/automation/test').send({ brandId: ctx.fx.brandA, platform: 'facebook', body: '禮盒多少錢？' });
    expect(gap.body.decision).toBe('human');
    expect(gap.body.forceHuman.map((r: { code: string }) => r.code)).toContain('knowledge_gap');
    await addKnowledge(ctx);
    const ok = await admin.post('/api/automation/test').send({ brandId: ctx.fx.brandA, platform: 'facebook', body: '禮盒多少錢？' });
    if (ok.body.decision !== 'auto_replied') throw new Error(JSON.stringify(ok.body));
    expect(ok.body.replyBody).toContain('1,280 元');
    // 客訴即使提到價格也不自動回覆
    const complaint = await admin.post('/api/automation/test').send({ brandId: ctx.fx.brandA, platform: 'facebook', body: '禮盒多少錢？上次買的漏水，品質很差' });
    expect(complaint.body.decision).toBe('human');
  });
});
