import { createTestContext } from '../test/helpers';
import { all, get, insert, run } from '../db';
import { addMinutes, nowIso } from '../lib/clock';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

async function addComment(ctx: Ctx, brand: 'A' | 'B', ext: string, extra: Record<string, unknown> = {}) {
  const now = nowIso();
  return insert(ctx.db, 'comments', {
    brand_id: brand === 'A' ? ctx.fx.brandA : ctx.fx.brandB,
    social_account_id: brand === 'A' ? ctx.fx.accountA : ctx.fx.accountB,
    post_id: brand === 'A' ? ctx.fx.postA : ctx.fx.postB,
    external_id: ext,
    author_name: '顧客',
    body: `留言 ${ext}`,
    occurred_at: now,
    fetched_at: now,
    created_at: now,
    updated_at: now,
    ...extra,
  });
}

describe('收件匣列表', () => {
  it('只列出自己品牌的留言，並提供各分頁筆數', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    const res = await op.get('/api/comments');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([ctx.fx.commentA]);
    expect(res.body.tabCounts.todo).toBe(1);
    expect((await op.get(`/api/comments?brand=${ctx.fx.brandB}`)).status).toBe(403);
  });

  it('已超時排最前面，可用時效篩選', async () => {
    const ctx = await createTestContext();
    const late = await addComment(ctx, 'A', 'late', { sla_due_at: addMinutes(nowIso(), -10), priority: 'low' });
    await addComment(ctx, 'A', 'soon', { sla_due_at: addMinutes(nowIso(), 5), priority: 'high' });
    await addComment(ctx, 'A', 'later', { sla_due_at: addMinutes(nowIso(), 50), priority: 'high' });
    const op = await ctx.loginAs('opA');
    const res = await op.get('/api/comments');
    expect(res.body.items[0].id).toBe(late);
    expect(res.body.items[1].body).toBe('留言 soon');
    expect(res.body.overdue).toBe(1);
    expect(res.body.nearDue).toBe(1);
    const overdue = await op.get('/api/comments?sla=overdue');
    expect(overdue.body.items.map((i: { id: number }) => i.id)).toEqual([late]);
  });

  it('處理中超過時限自動釋放，回到待處理並留下紀錄', async () => {
    const ctx = await createTestContext();
    await run(ctx.db, "UPDATE comments SET status = 'in_progress', locked_by_id = ?, lock_expires_at = ? WHERE id = ?", [ctx.fx.opA, addMinutes(nowIso(), -1), ctx.fx.commentA]);
    const op = await ctx.loginAs('opA');
    const res = await op.get('/api/comments');
    expect(res.body.items[0].status).toBe('pending');
    expect(res.body.items[0].lockedById).toBeNull();
    expect(await get(ctx.db, "SELECT id FROM audit_logs WHERE action = 'comment.lock_expired'")).toBeTruthy();
  });
});

describe('留言處理', () => {
  it('開始處理：鎖定、狀態變處理中、自動認領；別人不能同時處理', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    const res = await op.post(`/api/comments/${ctx.fx.commentA}/lock`).send({});
    expect(res.status).toBe(200);
    expect(res.body.comment.status).toBe('in_progress');
    expect(res.body.comment.assigneeId).toBe(ctx.fx.opA);
    expect(res.body.lock.isMine).toBe(true);

    const sup = await ctx.loginAs('sup');
    const blocked = await sup.post(`/api/comments/${ctx.fx.commentA}/reply`).send({ body: '您好', statusAfter: 'done' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('甲操作 正在處理');
  });

  it('主管可以強制接手，原處理人會收到通知；操作人員不行', async () => {
    const ctx = await createTestContext();
    const sup = await ctx.loginAs('sup');
    await sup.post(`/api/comments/${ctx.fx.commentA}/lock`).send({});
    const op = await ctx.loginAs('opA');
    expect((await op.post(`/api/comments/${ctx.fx.commentA}/lock`).send({ force: true })).status).toBe(403);

    const ctx2 = await createTestContext();
    const op2 = await ctx2.loginAs('opA');
    await op2.post(`/api/comments/${ctx2.fx.commentA}/lock`).send({});
    const sup2 = await ctx2.loginAs('sup');
    const res = await sup2.post(`/api/comments/${ctx2.fx.commentA}/lock`).send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.lock.byId).toBe(ctx2.fx.sup);
    expect(await get(ctx2.db, "SELECT id FROM audit_logs WHERE action = 'comment.lock_override'")).toBeTruthy();
    const notes = await op2.get('/api/notifications');
    expect(notes.body.unread).toBe(1);
  });

  it('回覆後選「等待對方」：已回覆但未完成；之後可改為已完成', async () => {
    const ctx = await createTestContext();
    await run(ctx.db, 'UPDATE comments SET sla_due_at = ? WHERE id = ?', [addMinutes(nowIso(), 30), ctx.fx.commentA]);
    const op = await ctx.loginAs('opA');
    const res = await op.post(`/api/comments/${ctx.fx.commentA}/reply`).send({ body: '請私訊提供訂單編號', statusAfter: 'waiting' });
    expect(res.status).toBe(201);
    expect(res.body.comment.status).toBe('waiting');
    expect(res.body.comment.firstResponseAt).not.toBeNull();
    expect(res.body.comment.completedAt).toBeNull();
    expect(res.body.comment.handledById).toBe(ctx.fx.opA);
    expect(res.body.replies).toHaveLength(1);
    const log = await get<{ detail: string }>(ctx.db, "SELECT detail FROM audit_logs WHERE action = 'comment.reply'");
    expect(JSON.parse(log!.detail).slaMet).toBe(true);

    const done = await op.post(`/api/comments/${ctx.fx.commentA}/status`).send({ status: 'done' });
    expect(done.body.comment.status).toBe('done');
    expect(done.body.comment.completedAt).not.toBeNull();
  });

  it('回覆說「已私訊」會加入私訊待辦，完成後離開分頁；結案也不影響待辦', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    const res = await op.post(`/api/comments/${ctx.fx.commentA}/reply`).send({ body: '已經私訊您了，請查收～', statusAfter: 'done' });
    expect(res.body.comment).toMatchObject({ status: 'done', dmTodo: 'send', dmDoneAt: null });
    const list = await op.get('/api/comments?tab=dm');
    expect(list.body.items.map((i: { id: number }) => i.id)).toEqual([ctx.fx.commentA]);
    expect(list.body.tabCounts.dm).toBe(1);

    const done = await op.post(`/api/comments/${ctx.fx.commentA}/dm`).send({ done: true });
    expect(done.body.comment.dmDoneAt).not.toBeNull();
    expect((await op.get('/api/comments?tab=dm')).body.tabCounts.dm).toBe(0);
    expect(await get(ctx.db, "SELECT id FROM audit_logs WHERE action = 'comment.dm_done'")).toBeTruthy();

    // 沒提到私訊的回覆不會加入；沒有待辦時不能標示完成
    const other = await addComment(ctx, 'A', 'dm-none');
    const plain = await op.post(`/api/comments/${other}/reply`).send({ body: '謝謝支持！', statusAfter: 'done' });
    expect(plain.body.comment.dmTodo).toBeNull();
    expect((await op.post(`/api/comments/${other}/dm`).send({ done: true })).status).toBe(400);
  });

    it('沒回覆過不能標示等待對方', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    expect((await op.post(`/api/comments/${ctx.fx.commentA}/status`).send({ status: 'waiting' })).status).toBe(400);
  });

  it('負責人與實際處理人分開記錄：指派給 A，由 B 回覆', async () => {
    const ctx = await createTestContext();
    const sup = await ctx.loginAs('sup');
    const assigned = await sup.post(`/api/comments/${ctx.fx.commentA}/assign`).send({ assigneeId: ctx.fx.opA, reason: '請協助回覆' });
    expect(assigned.body.comment.assigneeId).toBe(ctx.fx.opA);
    expect(assigned.body.comment.status).toBe('transferred');
    await sup.post(`/api/comments/${ctx.fx.commentA}/reply`).send({ body: '您好，已協助處理', statusAfter: 'done' });
    const c = await get<{ assignee_id: number; handled_by_id: number; original_assignee_id: number }>(ctx.db, 'SELECT assignee_id, handled_by_id, original_assignee_id FROM comments WHERE id = ?', [ctx.fx.commentA]);
    expect(c).toMatchObject({ assignee_id: ctx.fx.opA, handled_by_id: ctx.fx.sup, original_assignee_id: ctx.fx.opA });
    const op = await ctx.loginAs('opA');
    expect((await op.get('/api/notifications')).body.items[0].type).toBe('assigned');
  });

  it('操作人員只能轉交自己負責的留言，且對象必須有品牌權限', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    expect((await op.post(`/api/comments/${ctx.fx.commentA}/assign`).send({ assigneeId: ctx.fx.opB })).status).toBe(400);
    expect((await op.post(`/api/comments/${ctx.fx.commentA}/assign`).send({ assigneeId: ctx.fx.opA })).status).toBe(200);
    const transfer = await op.post(`/api/comments/${ctx.fx.commentA}/assign`).send({ assigneeId: ctx.fx.sup, reason: '需要主管判斷' });
    expect(transfer.body.comment.status).toBe('transferred');
    expect(transfer.body.assignments).toHaveLength(2);

    const c2 = await addComment(ctx, 'A', 'other', { assignee_id: ctx.fx.sup });
    expect((await op.post(`/api/comments/${c2}/assign`).send({ assigneeId: ctx.fx.opA })).status).toBe(403);
  });

  it('不能存取其他品牌的留言', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    expect((await op.get(`/api/comments/${ctx.fx.commentB}`)).status).toBe(404);
    expect((await op.post(`/api/comments/${ctx.fx.commentB}/reply`).send({ body: 'x', statusAfter: 'done' })).status).toBe(404);
  });

  it('內部備註 @提及會通知對方', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    const res = await op.post(`/api/comments/${ctx.fx.commentA}/notes`).send({ body: '@主管 這則要不要補償？' });
    expect(res.status).toBe(201);
    expect(res.body.notes[0].mentions).toEqual([ctx.fx.sup]);
    const sup = await ctx.loginAs('sup');
    const n = await sup.get('/api/notifications');
    expect(n.body.items[0].type).toBe('mention');
    await sup.post('/api/notifications/read').send({});
    expect((await sup.get('/api/notifications')).body.unread).toBe(0);
  });

  it('刪除必須確認並填寫理由；刪除後留言結案並保留紀錄', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    expect((await op.post(`/api/comments/${ctx.fx.commentA}/actions`).send({ action: 'delete' })).status).toBe(400);
    expect((await op.post(`/api/comments/${ctx.fx.commentA}/actions`).send({ action: 'delete', reason: '詐騙連結', confirm: false })).status).toBe(400);
    const res = await op.post(`/api/comments/${ctx.fx.commentA}/actions`).send({ action: 'delete', reason: '詐騙連結', confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.comment.visibility).toBe('deleted');
    expect(res.body.comment.status).toBe('no_action');
    const a = await all<{ confirmed_by_id: number; reason: string }>(ctx.db, "SELECT confirmed_by_id, reason FROM comment_actions WHERE action = 'delete'");
    expect(a).toEqual([{ confirmed_by_id: ctx.fx.opA, reason: '詐騙連結' }]);
  });

  it('隱藏與按讚', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    expect((await op.post(`/api/comments/${ctx.fx.commentA}/actions`).send({ action: 'hide', reason: '人身攻擊' })).body.comment.visibility).toBe('hidden');
    expect((await op.post(`/api/comments/${ctx.fx.commentA}/actions`).send({ action: 'hide' })).status).toBe(400);
    expect((await op.post(`/api/comments/${ctx.fx.commentA}/actions`).send({ action: 'like' })).body.comment.isLiked).toBe(true);
  });

  it('詳情包含前後脈絡（同串留言與品牌回覆）與操作紀錄', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    await op.post(`/api/comments/${ctx.fx.commentA}/reply`).send({ body: '請提供訂單編號', statusAfter: 'waiting' });
    const child = await addComment(ctx, 'A', 'child', { parent_comment_id: ctx.fx.commentA, thread_root_id: ctx.fx.commentA, body: '訂單是 123' });
    const res = await op.get(`/api/comments/${child}`);
    expect(res.body.thread.map((t: { kind: string }) => t.kind)).toEqual(['comment', 'reply', 'comment']);
    expect(res.body.thread[2].isCurrent).toBe(true);
    expect(res.body.directory.map((u: { id: number }) => u.id).sort()).toEqual([ctx.fx.admin, ctx.fx.sup, ctx.fx.opA].sort());
    const parent = await op.get(`/api/comments/${ctx.fx.commentA}`);
    expect(parent.body.history.some((h: { action: string }) => h.action === 'comment.reply')).toBe(true);
  });
});
