import { createTestContext } from '../test/helpers';
import { get, insert } from '../db';
import { nowIso } from '../lib/clock';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

async function addComment(ctx: Ctx, body: string, categoryKey: string) {
  const now = nowIso();
  const cat = await get<{ id: number }>(ctx.db, 'SELECT id FROM comment_categories WHERE key = ?', [categoryKey]);
  return insert(ctx.db, 'comments', {
    brand_id: ctx.fx.brandA,
    social_account_id: ctx.fx.accountA,
    post_id: ctx.fx.postA,
    external_id: `ext-${Math.random()}`,
    author_name: '小美',
    body,
    category_id: cat?.id ?? null,
    occurred_at: now,
    fetched_at: now,
    created_at: now,
    updated_at: now,
  });
}

const catId = async (ctx: Ctx, key: string) => (await get<{ id: number }>(ctx.db, 'SELECT id FROM comment_categories WHERE key = ?', [key]))!.id;

describe('標準回覆', () => {
  it('主管可新增、停用；小編只能讀取並在回覆時套用，回覆來源記為標準回覆', async () => {
    const ctx = await createTestContext();
    const sup = await ctx.loginAs('sup');
    const op = await ctx.loginAs('opA');
    const opB = await ctx.loginAs('opB');
    const input = { brandId: ctx.fx.brandA, categoryId: await catId(ctx, 'complaint'), title: '請私訊訂單', body: '{name} 您好，麻煩私訊訂單編號，會有專人協助。' };

    expect((await op.post('/api/canned-replies').send(input)).status).toBe(403);
    const created = await sup.post('/api/canned-replies').send(input);
    expect(created.status).toBe(201);
    expect(created.body.categoryName).toBe('客訴');

    const list = await op.get('/api/canned-replies').query({ brand: ctx.fx.brandA, active: '1' });
    expect(list.body.map((x: { id: number }) => x.id)).toContain(created.body.id);
    // 其他品牌看不到
    expect((await opB.get('/api/canned-replies').query({ brand: ctx.fx.brandA })).status).toBe(403);

    const id = await addComment(ctx, '我的訂單還沒到', 'complaint');
    const sent = await op.post(`/api/comments/${id}/reply`).send({ body: '小美 您好，麻煩私訊訂單編號，會有專人協助。', statusAfter: 'waiting', cannedReplyId: created.body.id });
    expect(sent.status).toBe(201);
    expect(sent.body.replies.at(-1).source).toBe('canned');

    // 不能用別的品牌的標準回覆
    const other = await (await ctx.loginAs('admin')).post('/api/canned-replies').send({ ...input, brandId: ctx.fx.brandB });
    const id2 = await addComment(ctx, '還沒到貨', 'complaint');
    expect((await op.post(`/api/comments/${id2}/reply`).send({ body: '請私訊', statusAfter: 'waiting', cannedReplyId: other.body.id })).status).toBe(404);

    const off = await sup.patch(`/api/canned-replies/${created.body.id}`).send({ isActive: false });
    expect(off.body.isActive).toBe(false);
    const active = await op.get('/api/canned-replies').query({ brand: ctx.fx.brandA, active: '1' });
    expect(active.body).toHaveLength(0);
  });
});

describe('回覆範例', () => {
  it('小編收錄的回覆需審核；通過後出現在同類型留言的 AI 建議中', async () => {
    const ctx = await createTestContext();
    const sup = await ctx.loginAs('sup');
    const op = await ctx.loginAs('opA');

    const id = await addComment(ctx, '你們的店員好親切！', 'praise');
    const sent = await op.post(`/api/comments/${id}/reply`).send({ body: '謝謝小美的肯定，我們會繼續努力，期待再見到您！', statusAfter: 'done' });
    const replyId = sent.body.replies.at(-1).id;

    const proposed = await op.post('/api/reply-examples/from-reply').send({ replyId, scenario: '顧客稱讚服務' });
    expect(proposed.status).toBe(201);
    expect(proposed.body.status).toBe('pending');
    expect(proposed.body.sampleComment).toBe('你們的店員好親切！');
    expect(proposed.body.categoryName).toBe('稱讚');
    // 同一則回覆不能重複收錄
    expect((await op.post('/api/reply-examples/from-reply').send({ replyId })).status).toBe(409);

    const detail = await op.get(`/api/comments/${id}`);
    expect(detail.body.thread.find((t: { kind: string; id: number }) => t.kind === 'reply' && t.id === replyId).exampleStatus).toBe('pending');

    const another = await addComment(ctx, '咖啡很好喝', 'praise');
    const before = await op.post(`/api/comments/${another}/suggestions`);
    expect(before.body.latest.examples).toHaveLength(0);

    expect((await op.post(`/api/reply-examples/${proposed.body.id}/review`).send({ decision: 'approve' })).status).toBe(403);
    const ok = await sup.post(`/api/reply-examples/${proposed.body.id}/review`).send({ decision: 'approve' });
    expect(ok.body.status).toBe('active');

    const after = await op.post(`/api/comments/${another}/suggestions`);
    expect(after.body.latest.examples.map((x: { id: number }) => x.id)).toEqual([proposed.body.id]);

    // 其他類型的留言不會帶入
    const q = await addComment(ctx, '請問幾點開門', 'product_inquiry');
    expect((await op.post(`/api/comments/${q}/suggestions`)).body.latest.examples).toHaveLength(0);

    const counts = await sup.get('/api/reply-examples').query({ brand: ctx.fx.brandA });
    expect(counts.body.counts).toMatchObject({ all: 1, active: 1, pending: 0 });

    const off = await sup.patch(`/api/reply-examples/${proposed.body.id}`).send({ isActive: false });
    expect(off.body.status).toBe('inactive');
  });

  it('主管直接新增的範例立即生效', async () => {
    const ctx = await createTestContext();
    const sup = await ctx.loginAs('sup');
    const res = await sup.post('/api/reply-examples').send({ brandId: ctx.fx.brandA, categoryId: null, sampleComment: '有停車位嗎', goodReply: '附近有收費停車場喔', badReply: '不知道' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
  });
});

describe('依留言類型調整語氣', () => {
  it('管理者可以修改各類型的語氣指引，並出現在 AI 建議的處理指引', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    const op = await ctx.loginAs('opA');
    const complaint = await catId(ctx, 'complaint');
    const rows = (await admin.get(`/api/brands/${ctx.fx.brandA}/category-settings`)).body as Array<{ categoryId: number; slaMinutes: number; slaEnabled: boolean; toneNote: string }>;
    const row = rows.find((r) => r.categoryId === complaint)!;
    expect(row.toneNote).toBe('');

    expect((await op.put(`/api/brands/${ctx.fx.brandA}/category-settings`).send({ items: [{ ...row, toneNote: 'x' }] })).status).toBe(403);
    const saved = await admin
      .put(`/api/brands/${ctx.fx.brandA}/category-settings`)
      .send({ items: [{ categoryId: complaint, slaMinutes: row.slaMinutes, slaEnabled: row.slaEnabled, toneNote: '認真同理，不開玩笑' }] });
    expect(saved.status).toBe(200);
    expect(saved.body.find((r: { categoryId: number }) => r.categoryId === complaint).toneNote).toBe('認真同理，不開玩笑');

    const id = await addComment(ctx, '東西壞了很生氣', 'complaint');
    const s = await op.post(`/api/comments/${id}/suggestions`);
    expect(s.body.latest.guidance).toBe('認真同理，不開玩笑');
  });
});

describe('人工答案存成知識', () => {
  it('從留言提出的知識會記錄來源留言', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    const id = await addComment(ctx, '週一有營業嗎', 'product_inquiry');
    const res = await op.post('/api/knowledge').send({ brandId: ctx.fx.brandA, category: 'faq', title: '週一有營業嗎', content: '每週一公休。', keywords: ['週一', '公休'], sourceCommentId: id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: 'from_reply', sourceCommentId: id, reviewStatus: 'pending' });
  });
});
