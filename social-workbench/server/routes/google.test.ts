import { createTestContext } from '../test/helpers';
import { all, get } from '../db';
import { setGoogleFetch } from '../integrations/google';

const CHANNEL = 'UCshop123';
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** 假的 Google API（登入、YouTube、商家檔案） */
function fakeGoogle() {
  const state = {
    threads: [] as Array<Record<string, unknown>>,
    replies: [] as Array<{ parentId: string; text: string; auth: string }>,
    moderation: [] as string[],
    reviews: [] as Array<Record<string, unknown>>,
    reviewReplies: [] as Array<{ name: string; comment: string }>,
    refreshCalls: 0,
    scope: '',
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  setGoogleFetch(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    if (url.hostname === 'oauth2.googleapis.com') {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'refresh_token') {
        state.refreshCalls++;
        return json({ access_token: `access-from-${form.get('refresh_token')}`, expires_in: 3600 });
      }
      return json({ access_token: 'first-access', refresh_token: 'refresh-1', expires_in: 3600, scope: state.scope });
    }
    const path = url.pathname;
    if (path === '/youtube/v3/channels') return json({ items: [{ id: CHANNEL, snippet: { title: '美髮小教室', customUrl: '@hairclass' }, contentDetails: { relatedPlaylists: { uploads: 'UUshop123' } } }] });
    if (path === '/youtube/v3/playlistItems') {
      return json({ items: [
        { snippet: { title: '冬季髮色推薦', description: '今年最流行' }, contentDetails: { videoId: 'v1', videoPublishedAt: ago(3000) } },
        { snippet: { title: '30 秒吹整技巧', description: '' }, contentDetails: { videoId: 'v2', videoPublishedAt: ago(2000) } },
      ] });
    }
    if (path === '/youtube/v3/videos') return json({ items: [{ id: 'v1', contentDetails: { duration: 'PT8M12S' } }, { id: 'v2', contentDetails: { duration: 'PT31S' } }] });
    if (path === '/youtube/v3/commentThreads') {
      expect(url.searchParams.get('allThreadsRelatedToChannelId')).toBe(CHANNEL);
      return json({ items: state.threads });
    }
    if (path === '/youtube/v3/comments' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { snippet: { parentId: string; textOriginal: string } };
      state.replies.push({ parentId: body.snippet.parentId, text: body.snippet.textOriginal, auth });
      return json({ id: `${body.snippet.parentId}.r${state.replies.length}` });
    }
    if (path === '/youtube/v3/comments/setModerationStatus') {
      state.moderation.push(`${url.searchParams.get('id')}:${url.searchParams.get('moderationStatus')}${url.searchParams.get('banAuthor') ? ':ban' : ''}`);
      return new Response(null, { status: 204 });
    }
    if (url.hostname === 'mybusinessaccountmanagement.googleapis.com') return json({ accounts: [{ name: 'accounts/9' }] });
    if (url.hostname === 'mybusinessbusinessinformation.googleapis.com') {
      return json({ locations: [{ name: 'locations/77', title: '邑伶質髮時尚館', storefrontAddress: { administrativeArea: '台北市', locality: '大安區', addressLines: ['忠孝東路 1 號'] } }] });
    }
    if (url.hostname === 'mybusiness.googleapis.com') {
      if (path === '/v4/accounts/9/locations/77/reviews') return json({ reviews: state.reviews, totalReviewCount: state.reviews.length });
      const m = path.match(/^\/v4\/(.+)\/reply$/);
      if (m && method === 'PUT') {
        state.reviewReplies.push({ name: m[1], comment: (JSON.parse(String(init?.body)) as { comment: string }).comment });
        return json({ comment: 'ok' });
      }
    }
    return json({ error: { code: 400, message: `unexpected ${method} ${url}` } }, 400);
  });
  return state;
}

const thread = (id: string, videoId: string, text: string, author: { name: string; channel: string }, min: number, replies: Array<Record<string, unknown>> = []) => ({
  id,
  snippet: {
    videoId,
    totalReplyCount: replies.length,
    topLevelComment: { id, snippet: { videoId, authorDisplayName: author.name, authorChannelId: { value: author.channel }, textOriginal: text, likeCount: 2, publishedAt: ago(min) } },
  },
  replies: replies.length ? { comments: replies } : undefined,
});

async function connect(ctx: Awaited<ReturnType<typeof createTestContext>>, target: 'youtube' | 'google_business', brandId = ctx.fx.brandA) {
  const admin = await ctx.loginAs('admin');
  const start = await admin.get(`/api/integrations/${target}/start?brandId=${brandId}`);
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.location);
  expect(loc.hostname).toBe('accounts.google.com');
  expect(loc.searchParams.get('access_type')).toBe('offline');
  const cb = await admin.get(`/api/integrations/google/callback?code=abc&state=${loc.searchParams.get('state')}`);
  return { admin, cb, scope: loc.searchParams.get('scope') ?? '' };
}

describe('Google 串接（YouTube、Google 商家）', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'g-client';
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
  });
  afterEach(() => {
    setGoogleFetch(null);
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  it('未設定 Google 用戶端時提示設定方式', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    const s = await admin.get('/api/integrations/youtube');
    expect(s.body.configured).toBe(false);
    expect(s.body.redirectUri).toMatch(/\/api\/integrations\/google\/callback$/);
    expect((await admin.get(`/api/integrations/youtube/start?brandId=${ctx.fx.brandA}`)).headers.location).toContain('yt_error=');
  });

  it('連結 YouTube 頻道：匯入影片（含 Shorts）與留言；頻道自己的回覆不算留言；可回覆與審核', async () => {
    const ctx = await createTestContext();
    const api = fakeGoogle();
    api.scope = 'https://www.googleapis.com/auth/youtube.force-ssl';
    api.threads.push(
      thread('t1', 'v1', '這個髮色好美，請問要多少錢？', { name: '@amy', channel: 'UCamy' }, 120, [
        { id: 't1.own', snippet: { videoId: 'v1', parentId: 't1', authorDisplayName: '@hairclass', authorChannelId: { value: CHANNEL }, textOriginal: '歡迎私訊預約', publishedAt: ago(100) } },
      ]),
      thread('t2', 'v2', '學會了，謝謝！', { name: '@ben', channel: 'UCben' }, 90),
    );
    const { admin, cb, scope } = await connect(ctx, 'youtube');
    expect(scope).toContain('youtube.force-ssl');
    expect(cb.headers.location).toContain('yt=connected');

    const acc = (await get<{ id: number; name: string; handle: string }>(ctx.db, "SELECT id, name, handle FROM social_accounts WHERE platform = 'youtube' AND external_id = ?", [CHANNEL]))!;
    expect(acc).toMatchObject({ name: '美髮小教室', handle: '@hairclass' });
    const posts = await all<{ external_id: string; content_type: string }>(ctx.db, 'SELECT external_id, content_type FROM posts WHERE social_account_id = ? ORDER BY external_id', [acc.id]);
    expect(posts).toEqual([{ external_id: 'v1', content_type: 'video' }, { external_id: 'v2', content_type: 'short' }]);
    const rows = await all<{ external_id: string; status: string }>(ctx.db, 'SELECT external_id, status FROM comments WHERE social_account_id = ? ORDER BY external_id', [acc.id]);
    expect(rows).toEqual([{ external_id: 't1', status: 'done' }, { external_id: 't2', status: 'pending' }]);

    // 資料庫只保存更新權杖，呼叫 API 時換成存取權杖
    const t2 = (await get<{ id: number }>(ctx.db, "SELECT id FROM comments WHERE external_id = 't2'"))!;
    expect((await admin.post(`/api/comments/${t2.id}/reply`).send({ body: '不客氣，歡迎訂閱！', statusAfter: 'done' })).status).toBe(201);
    expect(api.replies).toEqual([{ parentId: 't2', text: '不客氣，歡迎訂閱！', auth: 'Bearer first-access' }]);

    expect((await admin.post(`/api/comments/${t2.id}/actions`).send({ action: 'hide' })).status).toBeLessThan(300);
    expect(api.moderation).toEqual(['t2:heldForReview']);
    const like = await admin.post(`/api/comments/${t2.id}/actions`).send({ action: 'like' });
    expect(like.status).toBeGreaterThanOrEqual(400);

    const status = await admin.get('/api/integrations/youtube');
    expect(status.body.accounts[0]).toMatchObject({ username: 'hairclass', brandName: '品牌甲' });
  });

  it('連結 Google 商家：每個地點一個帳號，評論帶星等；已回覆的評論標示完成；可以回覆評論', async () => {
    const ctx = await createTestContext();
    const api = fakeGoogle();
    api.scope = 'https://www.googleapis.com/auth/business.manage';
    api.reviews.push(
      { name: 'accounts/9/locations/77/reviews/r1', reviewId: 'r1', reviewer: { displayName: '陳小姐' }, starRating: 'FIVE', comment: '設計師很細心！', createTime: ago(300), updateTime: ago(300), reviewReply: { comment: '謝謝您', updateTime: ago(200) } },
      { name: 'accounts/9/locations/77/reviews/r2', reviewId: 'r2', reviewer: { isAnonymous: true }, starRating: 'TWO', comment: '等太久了', createTime: ago(100), updateTime: ago(100) },
      { name: 'accounts/9/locations/77/reviews/r3', reviewId: 'r3', reviewer: { displayName: '王先生' }, starRating: 'FOUR', createTime: ago(50), updateTime: ago(50) },
    );
    const { admin, cb } = await connect(ctx, 'google_business');
    expect(cb.headers.location).toContain('gb=connected');
    const acc = (await get<{ id: number; name: string; handle: string; account_type: string }>(ctx.db, "SELECT id, name, handle, account_type FROM social_accounts WHERE platform = 'google'"))!;
    expect(acc).toMatchObject({ name: '邑伶質髮時尚館', handle: '台北市大安區忠孝東路 1 號', account_type: 'google_business' });
    const rows = await all<{ external_id: string; status: string; rating: number; author_name: string; body: string }>(
      ctx.db,
      'SELECT external_id, status, rating, author_name, body FROM comments WHERE social_account_id = ? ORDER BY external_id',
      [acc.id],
    );
    expect(rows.map((r) => [r.rating, r.status, r.author_name])).toEqual([
      [5, 'done', '陳小姐'],
      [2, 'pending', 'Google 使用者'],
      [4, 'pending', '王先生'],
    ]);
    expect(rows[2].body).toContain('4 顆星');

    const r2 = (await get<{ id: number }>(ctx.db, "SELECT id FROM comments WHERE external_id LIKE '%/r2'"))!;
    expect((await admin.post(`/api/comments/${r2.id}/reply`).send({ body: '很抱歉讓您久等，我們會改進預約安排。', statusAfter: 'done' })).status).toBe(201);
    expect(api.reviewReplies).toEqual([{ name: 'accounts/9/locations/77/reviews/r2', comment: '很抱歉讓您久等，我們會改進預約安排。' }]);
    // Google 評論不能隱藏或刪除
    expect((await admin.post(`/api/comments/${r2.id}/actions`).send({ action: 'hide' })).status).toBeGreaterThanOrEqual(400);

    // 中斷連結後保留評論
    expect((await admin.post(`/api/integrations/google_business/${acc.id}/disconnect`)).status).toBe(204);
    expect(await get(ctx.db, 'SELECT 1 AS x FROM account_credentials WHERE account_id = ?', [acc.id])).toBeUndefined();
    expect((await all(ctx.db, 'SELECT id FROM comments WHERE social_account_id = ?', [acc.id])).length).toBe(3);
  });

  it('授權時沒有勾選權限會提示重新連結；同一個頻道不能屬於兩個品牌', async () => {
    const ctx = await createTestContext();
    const api = fakeGoogle();
    api.scope = 'openid';
    const { cb } = await connect(ctx, 'youtube');
    expect(decodeURIComponent(cb.headers.location)).toContain('沒有勾選所有權限');

    api.scope = 'https://www.googleapis.com/auth/youtube.force-ssl';
    await connect(ctx, 'youtube');
    const again = await connect(ctx, 'youtube', ctx.fx.brandB);
    expect(decodeURIComponent(again.cb.headers.location)).toContain('已連結在');
  });
});
