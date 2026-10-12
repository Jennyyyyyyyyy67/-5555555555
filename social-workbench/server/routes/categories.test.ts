import { createTestContext } from '../test/helpers';
import { get } from '../db';

describe('留言類型與時效設定', () => {
  it('管理員可新增類型，所有品牌自動建立時效設定', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    const res = await admin.post('/api/categories').send({ name: '活動抽獎', defaultSlaMinutes: 120, defaultPriority: 'low', needsReply: true });
    expect(res.status).toBe(201);
    const s = await get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM brand_category_settings WHERE category_id = ?', [res.body.id]);
    expect(s!.n).toBe(2);
    expect((await admin.post('/api/categories').send({ name: '活動抽獎', defaultSlaMinutes: null, defaultPriority: 'low', needsReply: false })).status).toBe(409);
  });

  it('可停用類型，但「其他」不能停用；主管與操作人員不能修改', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    const cats = (await admin.get('/api/categories')).body as Array<{ id: number; key: string }>;
    const praise = cats.find((c) => c.key === 'praise')!;
    const other = cats.find((c) => c.key === 'other')!;
    expect((await admin.patch(`/api/categories/${praise.id}`).send({ isActive: false })).body.isActive).toBe(false);
    expect((await admin.patch(`/api/categories/${other.id}`).send({ isActive: false })).status).toBe(400);
    const sup = await ctx.loginAs('sup');
    expect((await sup.patch(`/api/categories/${praise.id}`).send({ isActive: true })).status).toBe(403);
  });

  it('品牌時效：可調整分鐘數或關閉計時，並留下紀錄；不可看其他品牌', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    const list = (await admin.get(`/api/brands/${ctx.fx.brandA}/category-settings`)).body as Array<{ categoryId: number; key: string; slaMinutes: number | null }>;
    expect(list).toHaveLength(16);
    const inquiry = list.find((x) => x.key === 'product_inquiry')!;
    expect(inquiry.slaMinutes).toBe(30);
    const res = await admin.put(`/api/brands/${ctx.fx.brandA}/category-settings`).send({ items: [{ categoryId: inquiry.categoryId, slaMinutes: 20, slaEnabled: true }] });
    expect(res.body.find((x: { key: string }) => x.key === 'product_inquiry').slaMinutes).toBe(20);
    expect(await get(ctx.db, "SELECT id FROM audit_logs WHERE action = 'brand.sla_update'")).toBeTruthy();
    expect((await admin.put(`/api/brands/${ctx.fx.brandA}/category-settings`).send({ items: [{ categoryId: inquiry.categoryId, slaMinutes: null, slaEnabled: true }] })).status).toBe(400);
    const op = await ctx.loginAs('opA');
    expect((await op.get(`/api/brands/${ctx.fx.brandB}/category-settings`)).status).toBe(404);
    expect((await op.put(`/api/brands/${ctx.fx.brandA}/category-settings`).send({ items: [] })).status).toBe(403);
  });
});

describe('模擬對方追問', () => {
  it('在「等待對方」的留言底下追問：原留言完成，新留言進入待處理並重新計時', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    const first = await admin.post('/api/automation/simulate').send({ postId: ctx.fx.postA, authorName: '阿德', body: '請問濾芯要怎麼更換？' });
    await admin.post(`/api/comments/${first.body.commentId}/reply`).send({ body: '請私訊提供型號，我們幫您確認', statusAfter: 'waiting' });
    const follow = await admin.post('/api/automation/simulate').send({ postId: ctx.fx.postA, parentCommentId: first.body.commentId, authorName: '阿德', body: '型號是 RO-600，請問怎麼換？' });
    expect(follow.status).toBe(201);
    const parent = await get<{ status: string }>(ctx.db, 'SELECT status FROM comments WHERE id = ?', [first.body.commentId]);
    expect(parent!.status).toBe('done');
    const child = await get<{ status: string; thread_root_id: number; sla_due_at: string | null }>(ctx.db, 'SELECT status, thread_root_id, sla_due_at FROM comments WHERE id = ?', [follow.body.commentId]);
    expect(child).toMatchObject({ status: 'pending', thread_root_id: first.body.commentId });
    expect(child!.sla_due_at).not.toBeNull();
    const detail = await admin.get(`/api/comments/${follow.body.commentId}`);
    expect(detail.body.thread.map((t: { kind: string }) => t.kind)).toEqual(['comment', 'reply', 'comment']);
  });
});
