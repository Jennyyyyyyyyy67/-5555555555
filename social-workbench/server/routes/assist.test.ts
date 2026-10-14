import { createTestContext } from '../test/helpers';
import { all, get, insert, run } from '../db';
import { nowIso } from '../lib/clock';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

async function addComment(ctx: Ctx, body: string, categoryKey: string, extra: Record<string, unknown> = {}) {
  const now = nowIso();
  const cat = await get<{ id: number }>(ctx.db, 'SELECT id FROM comment_categories WHERE key = ?', [categoryKey]);
  return insert(ctx.db, 'comments', {
    brand_id: ctx.fx.brandA,
    social_account_id: ctx.fx.accountA,
    post_id: ctx.fx.postA,
    external_id: `ext-${Math.random()}`,
    author_name: '顧客',
    body,
    category_id: cat?.id ?? null,
    occurred_at: now,
    fetched_at: now,
    created_at: now,
    updated_at: now,
    ...extra,
  });
}

async function addKnowledge(ctx: Ctx, extra: Record<string, unknown> = {}) {
  const now = nowIso();
  return insert(ctx.db, 'knowledge_items', {
    brand_id: ctx.fx.brandA,
    category: 'price',
    title: '禮盒價格',
    content: '耶誕禮盒早鳥價 1,280 元，11/30 前預購。',
    keywords: ['禮盒', '多少錢'],
    review_status: 'approved',
    created_at: now,
    updated_at: now,
    ...extra,
  });
}

describe('知識庫', () => {
  it('主管新增直接生效；小編提出需審核，審核後才會被 AI 引用', async () => {
    const ctx = await createTestContext();
    const sup = await ctx.loginAs('sup');
    const op = await ctx.loginAs('opA');
    const base = { brandId: ctx.fx.brandA, category: 'price', title: '禮盒價格', content: '耶誕禮盒早鳥價 1,280 元。', keywords: ['禮盒'] };

    const proposed = await op.post('/api/knowledge').send(base);
    expect(proposed.status).toBe(201);
    expect(proposed.body.reviewStatus).toBe('pending');

    const search1 = await op.post('/api/knowledge/search').send({ brandId: ctx.fx.brandA, body: '禮盒多少錢？' });
    expect(search1.body.hits).toHaveLength(0);

    expect((await op.post(`/api/knowledge/${proposed.body.id}/review`).send({ decision: 'approve' })).status).toBe(403);
    expect((await sup.post(`/api/knowledge/${proposed.body.id}/review`).send({ decision: 'reject' })).status).toBe(400); // 退回要寫原因
    const ok = await sup.post(`/api/knowledge/${proposed.body.id}/review`).send({ decision: 'approve' });
    expect(ok.body.reviewStatus).toBe('approved');

    const search2 = await op.post('/api/knowledge/search').send({ brandId: ctx.fx.brandA, body: '禮盒多少錢？' });
    expect(search2.body.hits.map((h: { id: number }) => h.id)).toEqual([proposed.body.id]);

    // 修改留下版本紀錄
    await sup.patch(`/api/knowledge/${proposed.body.id}`).send({ content: '耶誕禮盒早鳥價 1,180 元。', note: '價格調整' });
    const detail = await sup.get(`/api/knowledge/${proposed.body.id}`);
    expect(detail.body.item.version).toBe(2);
    expect(detail.body.revisions.map((r: { changeType: string }) => r.changeType)).toEqual(['update', 'approve', 'propose']);

    // 品牌乙看不到
    const opB = await ctx.loginAs('opB');
    expect((await opB.get(`/api/knowledge/${proposed.body.id}`)).status).toBe(404);
  });

  it('過期或停用的知識不會被引用', async () => {
    const ctx = await createTestContext();
    await addKnowledge(ctx, { valid_to: '2020-01-01' });
    await addKnowledge(ctx, { title: '停用', is_active: 0 });
    const op = await ctx.loginAs('opA');
    const res = await op.post('/api/knowledge/search').send({ brandId: ctx.fx.brandA, body: '禮盒多少錢？' });
    expect(res.body.hits).toHaveLength(0);
    expect(res.body.skipped[0].reason).toContain('到期');
  });
});

describe('AI 回覆建議', () => {
  it('有知識時直接引用知識內容，產生多個版本並留下紀錄', async () => {
    const ctx = await createTestContext();
    const kid = await addKnowledge(ctx);
    const id = await addComment(ctx, '請問耶誕禮盒多少錢？', 'price_inquiry');
    const op = await ctx.loginAs('opA');
    const res = await op.post(`/api/comments/${id}/suggestions`);
    expect(res.status).toBe(201);
    const set = res.body.latest;
    expect(set.knowledgeGap).toBe(false);
    expect(set.variants.length).toBeGreaterThanOrEqual(3);
    for (const v of set.variants) expect(v.knowledgeIds).toContain(kid);
    expect(set.variants.some((v: { body: string }) => v.body.includes('1,280 元'))).toBe(true);
    const log = await get(ctx.db, "SELECT * FROM audit_logs WHERE action = 'ai.suggest' AND comment_id = ?", [id]);
    expect(log).toBeTruthy();
    // 重新產生是新的一輪
    const again = await op.post(`/api/comments/${id}/suggestions`);
    expect(again.body.latest.round).toBe(2);
  });

  it('知識不足時標示「知識不足」，建議不包含任何金額', async () => {
    const ctx = await createTestContext();
    const id = await addComment(ctx, '這個多少錢？', 'price_inquiry');
    const op = await ctx.loginAs('opA');
    const set = (await op.post(`/api/comments/${id}/suggestions`)).body.latest;
    expect(set.knowledgeGap).toBe(true);
    expect(set.notes.join('')).toContain('知識不足');
    for (const v of set.variants) expect(v.body).not.toMatch(/\d+\s*元/);
  });

  it('客訴只致歉並引導私訊，不提供活潑版，並提示需人工判斷', async () => {
    const ctx = await createTestContext();
    const id = await addComment(ctx, '用一個月就漏水，我要退款', 'complaint', { risk_flags: JSON.stringify(['complaint', 'refund']), sentiment: 'negative' });
    const op = await ctx.loginAs('opA');
    const set = (await op.post(`/api/comments/${id}/suggestions`)).body.latest;
    expect(set.variants.map((v: { key: string }) => v.key)).not.toContain('lively');
    expect(set.forceHuman.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(['complaint', 'refund']));
    for (const v of set.variants) {
      expect(v.body).toMatch(/私訊/);
      expect(v.body).not.toMatch(/退款|賠償|保證/);
    }
  });

  it('採用建議送出會記錄來源；禁用詞擋下、無根據的金額需確認', async () => {
    const ctx = await createTestContext();
    await run(ctx.db, 'UPDATE brand_styles SET banned_words = ? WHERE brand_id = ?', [JSON.stringify(['保證']), ctx.fx.brandA]);
    await addKnowledge(ctx);
    const id = await addComment(ctx, '請問耶誕禮盒多少錢？', 'price_inquiry');
    const op = await ctx.loginAs('opA');
    const set = (await op.post(`/api/comments/${id}/suggestions`)).body.latest;
    const v = set.variants[0];

    const banned = await op.post(`/api/comments/${id}/reply`).send({ body: '我們保證最便宜', statusAfter: 'done' });
    expect(banned.status).toBe(422);
    expect(banned.body.error.code).toBe('reply_blocked');

    const check = await op.post(`/api/comments/${id}/check-reply`).send({ body: '特價 999 元喔' });
    expect(check.body.warnings[0].code).toBe('unverified_amount');
    const needConfirm = await op.post(`/api/comments/${id}/reply`).send({ body: '特價 999 元喔', statusAfter: 'done' });
    expect(needConfirm.status).toBe(422);
    expect(needConfirm.body.error.code).toBe('reply_warnings');

    const sent = await op.post(`/api/comments/${id}/reply`).send({ body: `${v.body}！`, statusAfter: 'done', suggestionId: v.id });
    expect(sent.status).toBe(201);
    const reply = await get<{ source: string; was_edited: number; ai_original_body: string }>(ctx.db, 'SELECT * FROM replies WHERE comment_id = ?', [id]);
    expect(reply?.source).toBe('ai_edited');
    expect(reply?.ai_original_body).toBe(v.body);
    const adopted = await all(ctx.db, 'SELECT id FROM ai_suggestions WHERE is_adopted = 1');
    expect(adopted).toHaveLength(1);
  });

  it('人工修正分類會重算回覆時限並留下紀錄', async () => {
    const ctx = await createTestContext();
    const id = await addComment(ctx, '請問有團購價嗎', 'other');
    const op = await ctx.loginAs('opA');
    const res = await op.post(`/api/comments/${id}/classify`).send({ categoryKey: 'bulk_purchase', priority: 'high', reason: '其實是團購' });
    expect(res.status).toBe(200);
    expect(res.body.comment.categoryKey).toBe('bulk_purchase');
    expect(res.body.comment.priority).toBe('high');
    expect(res.body.comment.slaDueAt).toBeTruthy();
    const log = await get<{ summary: string }>(ctx.db, "SELECT summary FROM audit_logs WHERE action = 'comment.reclassify'");
    expect(log?.summary).toContain('其實是團購');
  });
});

describe('品牌回覆風格', () => {
  it('管理員可修改、主管只能看；預覽依未儲存的設定產生', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    const sup = await ctx.loginAs('sup');
    const style = (await sup.get(`/api/brands/${ctx.fx.brandA}/style`)).body;
    const next = { ...style, addressing: '大大', signature: '品牌甲小編', emojiUsage: 'none' };
    delete next.brandId;
    delete next.updatedAt;
    delete next.updatedByName;
    expect((await sup.put(`/api/brands/${ctx.fx.brandA}/style`).send(next)).status).toBe(403);
    const saved = await admin.put(`/api/brands/${ctx.fx.brandA}/style`).send(next);
    expect(saved.status).toBe(200);
    expect(saved.body.addressing).toBe('大大');

    const preview = await sup.post(`/api/brands/${ctx.fx.brandA}/style/preview`).send({ body: '好喜歡你們的咖啡！', style: { ...next, signature: '預覽署名' } });
    expect(preview.status).toBe(200);
    expect(preview.body.variants[0].body).toContain('大大');
    expect(preview.body.variants[0].body).toContain('預覽署名');
  });
});
