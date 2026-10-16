import { createTestContext } from '../test/helpers';
import { all, get } from '../db';
import { setFacebookFetch } from '../integrations/facebook';

const PAGE = '1029384756';
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace('Z', '+0000');

/** 假的 Facebook Graph API */
function fakeFacebook() {
  const state = {
    comments: [] as Array<Record<string, unknown>>,
    replies: [] as Array<{ commentId: string; message: string; token: string }>,
    hidden: [] as string[],
    liked: [] as string[],
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  setFacebookFetch(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/v[\d.]+/, '');
    if (path === '/oauth/access_token') {
      return json({ access_token: url.searchParams.get('grant_type') === 'fb_exchange_token' ? 'long-user-token' : 'short-user-token' });
    }
    if (path === '/me/accounts') return json({ data: [{ id: PAGE, name: '舞蹈教室粉專', access_token: 'page-token', tasks: ['MODERATE', 'CREATE_CONTENT'] }] });
    if (path === `/${PAGE}/posts`) return json({ data: [{ id: `${PAGE}_1`, message: '週末成果發表\n歡迎來看', created_time: ago(600), permalink_url: 'https://www.facebook.com/1' }] });
    if (path === `/${PAGE}_1/comments` && method === 'GET') return json({ data: state.comments });
    const m = path.match(/^\/([^/]+)\/comments$/);
    if (m && method === 'POST') {
      const form = new URLSearchParams(String(init?.body));
      state.replies.push({ commentId: m[1], message: form.get('message') ?? '', token: form.get('access_token') ?? '' });
      return json({ id: `${m[1]}_r${state.replies.length}` });
    }
    const like = path.match(/^\/([^/]+)\/likes$/);
    if (like && method === 'POST') {
      state.liked.push(like[1]);
      return json({ success: true });
    }
    const hide = path.match(/^\/([^/]+)$/);
    if (hide && method === 'POST') {
      state.hidden.push(hide[1]);
      return json({ success: true });
    }
    return json({ error: { message: `unexpected ${method} ${path}`, code: 100 } }, 400);
  });
  return state;
}

async function connect(ctx: Awaited<ReturnType<typeof createTestContext>>) {
  const admin = await ctx.loginAs('admin');
  const start = await admin.get(`/api/integrations/facebook/start?brandId=${ctx.fx.brandA}`);
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.location);
  expect(loc.hostname).toBe('www.facebook.com');
  expect(loc.searchParams.get('scope')).toContain('pages_manage_engagement');
  const cb = await admin.get(`/api/integrations/facebook/callback?code=abc&state=${loc.searchParams.get('state')}`);
  return { admin, cb };
}

describe('Facebook 粉絲專頁串接', () => {
  beforeEach(() => {
    process.env.FACEBOOK_APP_ID = 'fb-app';
    process.env.FACEBOOK_APP_SECRET = 'fb-secret';
  });
  afterEach(() => {
    setFacebookFetch(null);
    delete process.env.FACEBOOK_APP_ID;
    delete process.env.FACEBOOK_APP_SECRET;
  });

  it('未設定 App 時提示設定方式', async () => {
    delete process.env.FACEBOOK_APP_ID;
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    const s = await admin.get('/api/integrations/facebook');
    expect(s.body.configured).toBe(false);
    expect(s.body.redirectUri).toMatch(/\/api\/integrations\/facebook\/callback$/);
    expect((await admin.get(`/api/integrations/facebook/start?brandId=${ctx.fx.brandA}`)).headers.location).toContain('fb_error=');
  });

  it('連結粉專、匯入留言；粉專自己的回覆不算留言，被回覆過的留言標示已完成', async () => {
    const ctx = await createTestContext();
    const api = fakeFacebook();
    api.comments.push(
      { id: 'c1', message: '請問課程多少錢？', created_time: ago(120), from: { id: 'u1', name: '小美' } },
      { id: 'c1_r', message: '已私訊你囉', created_time: ago(110), from: { id: PAGE, name: '舞蹈教室粉專' }, parent: { id: 'c1' } },
      { id: 'c2', message: '跳得好棒！', created_time: ago(100) },
    );
    const { admin, cb } = await connect(ctx);
    expect(cb.headers.location).toContain('fb=connected');
    const acc = await get<{ id: number; name: string; account_type: string }>(ctx.db, "SELECT id, name, account_type FROM social_accounts WHERE platform = 'facebook' AND external_id = ?", [PAGE]);
    expect(acc).toMatchObject({ name: '舞蹈教室粉專', account_type: 'fb_page' });
    const rows = await all<{ external_id: string; status: string; author_name: string; sla_due_at: string | null }>(ctx.db, 'SELECT external_id, status, author_name, sla_due_at FROM comments WHERE social_account_id = ? ORDER BY external_id', [acc!.id]);
    expect(rows.map((r) => r.external_id)).toEqual(['c1', 'c2']);
    expect(rows[0]).toMatchObject({ status: 'done' });
    expect(rows[1]).toMatchObject({ status: 'pending', author_name: 'Facebook 使用者', sla_due_at: null }); // 連結前的留言不計時效

    const status = await admin.get('/api/integrations/facebook');
    expect(status.body.accounts[0]).toMatchObject({ username: '舞蹈教室粉專' });

    // 回覆與按讚、隱藏都送到 Facebook，並以粉專權杖執行
    const c2 = (await get<{ id: number }>(ctx.db, "SELECT id FROM comments WHERE external_id = 'c2'"))!;
    expect((await admin.post(`/api/comments/${c2.id}/reply`).send({ body: '謝謝支持！', statusAfter: 'done' })).status).toBe(201);
    expect(api.replies).toEqual([{ commentId: 'c2', message: '謝謝支持！', token: 'page-token' }]);
    expect((await admin.post(`/api/comments/${c2.id}/actions`).send({ action: 'like' })).status).toBeLessThan(300);
    expect(api.liked).toEqual(['c2']);
  });

  it('新留言依關鍵字規則自動回覆；中斷連結後保留留言', async () => {
    const ctx = await createTestContext();
    const api = fakeFacebook();
    const { admin } = await connect(ctx);
    await admin.post('/api/automation/rules').send({
      brandId: ctx.fx.brandA, name: '課程價格', action: 'auto_reply', matchType: 'keyword', keywords: ['多少錢'],
      replyTemplate: '{name} 你好～課程資訊已私訊給你囉', categories: [], platforms: ['facebook'], minConfidence: 0.85, isActive: true,
    });
    api.comments.push({ id: 'c-new', message: '請問多少錢', created_time: new Date(Date.now() + 1000).toISOString(), from: { id: 'u9', name: '阿凱' } });
    const acc = (await get<{ id: number }>(ctx.db, "SELECT id FROM social_accounts WHERE platform = 'facebook' AND external_id = ?", [PAGE]))!;
    await admin.post(`/api/integrations/sync/${acc.id}`);
    expect(api.replies).toEqual([{ commentId: 'c-new', message: '阿凱 你好～課程資訊已私訊給你囉', token: 'page-token' }]);
    expect((await admin.post(`/api/integrations/facebook/${acc.id}/disconnect`)).status).toBe(204);
    expect(await get(ctx.db, 'SELECT 1 AS x FROM account_credentials WHERE account_id = ?', [acc.id])).toBeUndefined();
    expect(await get(ctx.db, "SELECT id FROM comments WHERE external_id = 'c-new'")).toBeTruthy();
  });

  it('同一個粉專不能同時屬於兩個品牌', async () => {
    const ctx = await createTestContext();
    fakeFacebook();
    await connect(ctx);
    const admin = await ctx.loginAs('admin');
    const start = await admin.get(`/api/integrations/facebook/start?brandId=${ctx.fx.brandB}`);
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await admin.get(`/api/integrations/facebook/callback?code=abc&state=${state}`);
    expect(decodeURIComponent(cb.headers.location)).toContain('已連結在');
  });
});
