import request from 'supertest';
import { createTestContext } from '../test/helpers';
import { all, get, insert, run } from '../db';
import { resetAndSeed } from '../seed';
import { DEMO_PASSWORD, DEMO_USERS } from '../seed/demo';
import type { MockStatsResponse } from '../../shared/types';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
const auditCount = async (ctx: Ctx) => (await get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM audit_logs'))!.n;
const resetLogs = async (ctx: Ctx) =>
  await all<{ actor_type: string; actor_user_id: number | null; summary: string; detail: string | null }>(
    ctx.db,
    "SELECT actor_type, actor_user_id, summary, detail FROM audit_logs WHERE action = 'mock.reset' ORDER BY id",
  );
const setCookieHeader = (res: request.Response): string => {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
};

describe('GET /api/mock/stats', () => {
  it('管理員取得 fixture 的資料量與各品牌統計', async () => {
    const ctx = await createTestContext();
    // 讓品牌甲多一則已完成的 Instagram 留言，確認依平台／狀態分組
    const igAccount = await insert(ctx.db, 'social_accounts', {
      brand_id: ctx.fx.brandA, platform: 'instagram', account_type: 'ig_account', name: 'IG 甲',
      external_id: 'ig-a', adapter_key: 'mock:instagram', created_at: '2026-01-01', updated_at: '2026-01-01',
    });
    const igPost = await insert(ctx.db, 'posts', {
      brand_id: ctx.fx.brandA, social_account_id: igAccount, external_id: 'ig-p', content_type: 'reel',
      title: 'Reels', published_at: '2026-01-01', created_at: '2026-01-01',
    });
    await insert(ctx.db, 'comments', {
      brand_id: ctx.fx.brandA, social_account_id: igAccount, post_id: igPost, external_id: 'ig-c', author_name: '顧客',
      body: '好看', status: 'done', occurred_at: '2026-01-01', fetched_at: '2026-01-01', created_at: '2026-01-01', updated_at: '2026-01-01',
    });

    const agent = await ctx.loginAs('admin');
    const res = await agent.get('/api/mock/stats');
    expect(res.status).toBe(200);
    const body = res.body as MockStatsResponse;
    expect(body.seededAt).toBeNull();
    expect(body.totals).toEqual({
      brands: 2,
      users: 4,
      accounts: 3,
      posts: 3,
      comments: 3,
      replies: 0,
      auditLogs: await auditCount(ctx),
    });
    expect(body.totals.auditLogs).toBeGreaterThanOrEqual(1); // 至少有管理員的登入紀錄
    expect(body.byBrand).toEqual([
      {
        brandId: ctx.fx.brandA, brandName: '品牌甲', brandColor: '#123456', accounts: 2, posts: 2, comments: 2,
        byPlatform: { facebook: 1, instagram: 1 }, byStatus: { pending: 1, done: 1 },
      },
      {
        brandId: ctx.fx.brandB, brandName: '品牌乙', brandColor: '#123456', accounts: 1, posts: 1, comments: 1,
        byPlatform: { facebook: 1 }, byStatus: { pending: 1 },
      },
    ]);
  });

  it('回傳資料建立時間，且停用中的品牌也列入統計', async () => {
    const ctx = await createTestContext();
    await run(ctx.db, "INSERT INTO schema_meta (key, value) VALUES ('seeded_at', '2026-01-02T03:04:05.000Z')");
    await run(ctx.db, 'UPDATE brands SET is_active = 0 WHERE id = ?', [ctx.fx.brandB]);
    const agent = await ctx.loginAs('admin');
    const res = await agent.get('/api/mock/stats');
    expect(res.status).toBe(200);
    expect(res.body.seededAt).toBe('2026-01-02T03:04:05.000Z');
    expect(res.body.byBrand.map((b: { brandId: number }) => b.brandId)).toEqual([ctx.fx.brandA, ctx.fx.brandB]);
  });

  it('主管、操作人員回傳 403；未登入回傳 401', async () => {
    const ctx = await createTestContext();
    for (const who of ['sup', 'opA', 'opB'] as const) {
      const agent = await ctx.loginAs(who);
      const res = await agent.get('/api/mock/stats');
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBeTruthy();
    }
    expect((await request(ctx.app).get('/api/mock/stats')).status).toBe(401);
  });
});

describe('POST /api/mock/reset', () => {
  it('非管理員回傳 403，資料不會被清空', async () => {
    const ctx = await createTestContext();
    for (const who of ['sup', 'opA'] as const) {
      const agent = await ctx.loginAs(who);
      expect((await agent.post('/api/mock/reset').send({ confirm: true })).status).toBe(403);
    }
    expect((await get<{ name: string }>(ctx.db, 'SELECT name FROM brands WHERE id = ?', [ctx.fx.brandA]))?.name).toBe('品牌甲');
    expect(await resetLogs(ctx)).toHaveLength(0);
  });

  it('未確認（缺少 confirm 或不是 true）回傳 400，資料不會被清空', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    for (const body of [{}, { confirm: false }, { confirm: 'true' }]) {
      const res = await agent.post('/api/mock/reset').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('請確認要重設示範資料');
    }
    expect((await get<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM users WHERE email = 'admin@test.tw'"))?.n).toBe(1);
    expect(await resetLogs(ctx)).toHaveLength(0);
  });

  it('執行者不在示範資料中：重設後回傳 me = null、清除 cookie，並以系統身分寫入操作紀錄', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    const other = await ctx.loginAs('opA');
    const res = await agent.post('/api/mock/reset').send({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.me).toBeNull();
    expect(res.body.summary.brands).toBeGreaterThan(0);
    expect(setCookieHeader(res)).toMatch(/swb_session=;/);

    // 舊資料已清空、示範資料已建立
    expect((await get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM brands'))!.n).toBeGreaterThan(0);
    expect(await get(ctx.db, "SELECT id FROM users WHERE email = 'admin@test.tw'")).toBeUndefined();
    for (const u of DEMO_USERS) expect(await get(ctx.db, 'SELECT id FROM users WHERE email = ?', [u.email])).toBeDefined();

    // 所有舊的登入狀態都已失效
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    expect((await other.get('/api/auth/me')).status).toBe(401);

    const logs = await resetLogs(ctx);
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_type).toBe('system');
    expect(logs[0].actor_user_id).toBeNull();
    expect(logs[0].summary).toContain('重設示範資料');
    expect(logs[0].detail).not.toMatch(/password/i);
  });

  it('執行者仍在示範資料中：重設後保持登入，回傳新的 me 並以新帳號 id 寫入操作紀錄', async () => {
    const ctx = await createTestContext();
    await resetAndSeed(ctx.db);
    const demoAdmin = DEMO_USERS.find((u) => u.role === 'admin')!;
    const agent = await ctx.loginWith(demoAdmin.email, DEMO_PASSWORD);

    const res = await agent.post('/api/mock/reset').send({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.me).not.toBeNull();
    expect(res.body.me.user.email).toBe(demoAdmin.email);
    expect(res.body.me.user.role).toBe('admin');
    expect(res.body.me.brands.length).toBeGreaterThan(0);
    expect(setCookieHeader(res)).toMatch(/swb_session=[0-9a-f]{64}/);

    // 同一個 agent 仍可繼續使用 API
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(res.body.me.user.id);
    expect((await agent.get('/api/mock/stats')).status).toBe(200);

    const logs = await resetLogs(ctx);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor_type: 'user', actor_user_id: res.body.me.user.id, summary: '重設示範資料' });
    expect(JSON.parse(logs[0].detail!)).toMatchObject({ brands: res.body.summary.brands });
  });
});
