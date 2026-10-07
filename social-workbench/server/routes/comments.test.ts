import request from 'supertest';
import { createTestContext } from '../test/helpers';
import { get, insert, run } from '../db';
import type { CommentPreview, Paginated } from '../../shared/types';

type Ctx = ReturnType<typeof createTestContext>;
type Page = Paginated<CommentPreview>;

/** 在指定品牌的 fixture 帳號／貼文下新增一則留言 */
function addComment(ctx: Ctx, brand: 'A' | 'B', ext: string, fields: Record<string, unknown> = {}): number {
  const brandId = brand === 'A' ? ctx.fx.brandA : ctx.fx.brandB;
  const accountId = brand === 'A' ? ctx.fx.accountA : ctx.fx.accountB;
  const postId = brand === 'A' ? ctx.fx.postA : ctx.fx.postB;
  return insert(ctx.db, 'comments', {
    brand_id: brandId, social_account_id: accountId, post_id: postId, external_id: ext, author_name: '顧客',
    body: `留言 ${ext}`, occurred_at: '2026-01-01T00:00:00.000Z', fetched_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', ...fields,
  });
}

describe('GET /api/comments/preview：品牌隔離', () => {
  it('操作人員甲只看到品牌甲的留言，並帶出品牌、帳號、貼文資訊', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('opA');
    const res = await agent.get('/api/comments/preview');
    expect(res.status).toBe(200);
    const body = res.body as Page;
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: ctx.fx.commentA,
      brandId: ctx.fx.brandA,
      brandName: '品牌甲',
      brandColor: '#123456',
      platform: 'facebook',
      accountId: ctx.fx.accountA,
      accountName: '粉專 fx-a',
      accountType: 'fb_page',
      postId: ctx.fx.postA,
      postTitle: '貼文 p-a',
      contentType: 'post',
      isAd: false,
      parentCommentId: null,
      body: '品牌甲的留言',
      status: 'pending',
      tags: [],
      riskFlags: [],
      categoryName: null,
      assigneeName: null,
      visibility: 'visible',
    });
  });

  it('操作人員乙只看到品牌乙；管理員看到全部', async () => {
    const ctx = createTestContext();
    const opB = await ctx.loginAs('opB');
    const resB = await opB.get('/api/comments/preview');
    expect(resB.status).toBe(200);
    expect(resB.body.items.map((c: CommentPreview) => c.id)).toEqual([ctx.fx.commentB]);

    const admin = await ctx.loginAs('admin');
    const resAll = await admin.get('/api/comments/preview');
    expect(resAll.body.total).toBe(2);
  });

  it('指定沒有權限的品牌回傳 403', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('opA');
    const res = await agent.get('/api/comments/preview').query({ brand: ctx.fx.brandB });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBeTruthy();
    expect((await agent.get('/api/comments/preview').query({ brand: 'abc' })).status).toBe(400);
  });

  it('指定其他品牌的社群帳號只會得到空結果', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('opA');
    const other = await agent.get('/api/comments/preview').query({ accountId: ctx.fx.accountB });
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ items: [], total: 0 });
    const own = await agent.get('/api/comments/preview').query({ accountId: ctx.fx.accountA });
    expect(own.body.total).toBe(1);
    expect((await agent.get('/api/comments/preview').query({ accountId: 'x' })).status).toBe(400);
  });

  it('預設不含停用中品牌的留言（管理員也一樣）', async () => {
    const ctx = createTestContext();
    run(ctx.db, 'UPDATE brands SET is_active = 0 WHERE id = ?', [ctx.fx.brandB]);
    const agent = await ctx.loginAs('admin');
    const res = await agent.get('/api/comments/preview');
    expect(res.body.items.map((c: CommentPreview) => c.brandId)).toEqual([ctx.fx.brandA]);
  });

  it('未登入回傳 401', async () => {
    const ctx = createTestContext();
    expect((await request(ctx.app).get('/api/comments/preview')).status).toBe(401);
  });
});

describe('GET /api/comments/preview：篩選與分頁', () => {
  it('依狀態、平台篩選；狀態不正確回傳 400', async () => {
    const ctx = createTestContext();
    addComment(ctx, 'A', 'done-1', { status: 'done' });
    const agent = await ctx.loginAs('opA');

    const done = await agent.get('/api/comments/preview').query({ status: 'done' });
    expect(done.status).toBe(200);
    expect(done.body.items.map((c: CommentPreview) => c.status)).toEqual(['done']);

    const pending = await agent.get('/api/comments/preview').query({ status: 'pending' });
    expect(pending.body.total).toBe(1);

    const bad = await agent.get('/api/comments/preview').query({ status: 'closed' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('狀態');

    expect((await agent.get('/api/comments/preview').query({ platform: 'facebook' })).body.total).toBe(2);
    expect((await agent.get('/api/comments/preview').query({ platform: 'youtube' })).body.total).toBe(0);
  });

  it('搜尋留言內容與留言者名稱，% 與 _ 視為一般文字', async () => {
    const ctx = createTestContext();
    addComment(ctx, 'A', 'pct', { body: '折扣真的有 50% 嗎', author_name: '小明' });
    addComment(ctx, 'A', 'name', { body: '請問門市在哪', author_name: '王_大同' });
    addComment(ctx, 'B', 'b-hit', { body: '折扣真的有 50% 嗎（品牌乙）' });
    const agent = await ctx.loginAs('opA');

    const byBody = await agent.get('/api/comments/preview').query({ q: '50%' });
    expect(byBody.status).toBe(200);
    expect(byBody.body.items.map((c: CommentPreview) => c.authorName)).toEqual(['小明']); // 品牌乙的同樣內容不會出現

    const byAuthor = await agent.get('/api/comments/preview').query({ q: '王_' });
    expect(byAuthor.body.items.map((c: CommentPreview) => c.authorName)).toEqual(['王_大同']);

    expect((await agent.get('/api/comments/preview').query({ q: '%' })).body.total).toBe(1);
    expect((await agent.get('/api/comments/preview').query({ q: '_' })).body.total).toBe(1);
    expect((await agent.get('/api/comments/preview').query({ q: '不存在的字' })).body.total).toBe(0);
    expect((await agent.get('/api/comments/preview').query({ q: 'x'.repeat(101) })).status).toBe(400);
  });

  it('依時間由新到舊排序並分頁；limit 預設 50、最多 200', async () => {
    const ctx = createTestContext();
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) ids.push(addComment(ctx, 'A', `p${i}`, { occurred_at: `2026-02-0${i}T00:00:00.000Z` }));
    const agent = await ctx.loginAs('opA');

    const page1 = await agent.get('/api/comments/preview').query({ limit: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body).toMatchObject({ total: 6, limit: 2, offset: 0 });
    expect(page1.body.items.map((c: CommentPreview) => c.id)).toEqual([ids[4], ids[3]]);

    const page3 = await agent.get('/api/comments/preview').query({ limit: 2, offset: 4 });
    expect(page3.body.items.map((c: CommentPreview) => c.id)).toEqual([ids[0], ctx.fx.commentA]);
    expect(page3.body.offset).toBe(4);

    expect((await agent.get('/api/comments/preview')).body.limit).toBe(50);
    expect((await agent.get('/api/comments/preview').query({ limit: 999 })).body.limit).toBe(200);
    expect((await agent.get('/api/comments/preview').query({ limit: 0 })).status).toBe(400);
    expect((await agent.get('/api/comments/preview').query({ limit: 'abc' })).status).toBe(400);
    expect((await agent.get('/api/comments/preview').query({ offset: -1 })).status).toBe(400);
  });

  it('同一時間的留言以 id 由大到小排序，並帶出類型、負責人、標籤等欄位', async () => {
    const ctx = createTestContext();
    const category = get<{ id: number }>(ctx.db, "SELECT id FROM comment_categories WHERE key = 'complaint'")!;
    const id = addComment(ctx, 'A', 'rich', {
      category_id: category.id, priority: 'high', assignee_id: ctx.fx.opA, tags: ['濾芯', '漏水'],
      risk_flags: ['complaint'], risk_level: 'medium', sentiment: 'negative', handling_mode: 'manual',
      sla_due_at: '2026-01-01T00:15:00.000Z', rating: 2,
    });
    const agent = await ctx.loginAs('sup');
    const res = await agent.get('/api/comments/preview');
    expect(res.body.items.map((c: CommentPreview) => c.id)).toEqual([id, ctx.fx.commentA]);
    expect(res.body.items[0]).toMatchObject({
      categoryKey: 'complaint',
      categoryName: '客訴',
      priority: 'high',
      assigneeId: ctx.fx.opA,
      assigneeName: '甲操作',
      tags: ['濾芯', '漏水'],
      riskFlags: ['complaint'],
      riskLevel: 'medium',
      sentiment: 'negative',
      handlingMode: 'manual',
      slaDueAt: '2026-01-01T00:15:00.000Z',
      rating: 2,
    });
  });
});
