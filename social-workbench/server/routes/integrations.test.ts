import { createHmac } from 'node:crypto';
import { createTestContext } from '../test/helpers';
import { all, get } from '../db';
import { setInstagramFetch } from '../integrations/instagram';

const IG_USER = '17841400000000001';
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace('Z', '+0000');

/** 假的 Instagram API：記錄送出的回覆，留言內容可在測試中增加 */
function fakeInstagram() {
  const state = {
    comments: [] as Array<Record<string, unknown>>,
    replies: [] as Array<{ commentId: string; message: string; token: string }>,
    hidden: [] as string[],
    /** GET /{留言}/replies 的回傳（巢狀查詢沒有作者時會另外查） */
    repliesOf: {} as Record<string, Array<Record<string, unknown>>>,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  setInstagramFetch(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.hostname === 'api.instagram.com') return json({ access_token: 'short-token', user_id: 999, permissions: 'instagram_business_basic,instagram_business_manage_comments' });
    if (url.pathname === '/access_token') return json({ access_token: 'long-token', token_type: 'bearer', expires_in: 5184000 });
    if (url.pathname.endsWith('/me')) return json({ id: 'app-scoped', user_id: IG_USER, username: 'shop_tw', name: '測試小店', account_type: 'BUSINESS' });
    if (url.pathname.endsWith('/me/media')) {
      return json({ data: [{ id: 'm1', caption: '秋季新品上市\n歡迎留言詢問', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/abc/', timestamp: ago(600) }] });
    }
    if (url.pathname.endsWith('/m1/comments')) return json({ data: state.comments });
    const replyMatch = url.pathname.match(/\/([^/]+)\/replies$/);
    if (replyMatch && method === 'GET') return json({ data: state.repliesOf[replyMatch[1]] ?? [] });
    if (replyMatch && method === 'POST') {
      const form = new URLSearchParams(String(init?.body));
      state.replies.push({ commentId: replyMatch[1], message: form.get('message') ?? '', token: form.get('access_token') ?? '' });
      return json({ id: `reply-${state.replies.length}` });
    }
    const hideMatch = url.pathname.match(/\/v[\d.]+\/([^/]+)$/);
    if (hideMatch && method === 'POST') {
      state.hidden.push(hideMatch[1]);
      return json({ success: true });
    }
    return json({ error: { message: `unexpected ${method} ${url.pathname}`, code: 100 } }, 400);
  });
  return state;
}

async function connect(ctx: Awaited<ReturnType<typeof createTestContext>>) {
  const admin = await ctx.loginAs('admin');
  const start = await admin.get(`/api/integrations/instagram/start?brandId=${ctx.fx.brandA}`);
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.location);
  expect(loc.hostname).toBe('www.instagram.com');
  expect(loc.searchParams.get('scope')).toContain('instagram_business_manage_comments');
  const cb = await admin.get(`/api/integrations/instagram/callback?code=abc123&state=${loc.searchParams.get('state')}`);
  return { admin, cb };
}

describe('Instagram 真實帳號串接', () => {
  beforeEach(() => {
    process.env.INSTAGRAM_APP_ID = 'app-id';
    process.env.INSTAGRAM_APP_SECRET = 'app-secret';
    process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = 'verify-me';
  });
  afterEach(() => {
    setInstagramFetch(null);
    delete process.env.INSTAGRAM_APP_ID;
    delete process.env.INSTAGRAM_APP_SECRET;
    delete process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;
  });

  it('未設定 App 時提示設定方式', async () => {
    delete process.env.INSTAGRAM_APP_ID;
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    const s = await admin.get('/api/integrations/instagram');
    expect(s.body.configured).toBe(false);
    expect(s.body.redirectUri).toMatch(/\/api\/integrations\/instagram\/callback$/);
    const start = await admin.get(`/api/integrations/instagram/start?brandId=${ctx.fx.brandA}`);
    expect(start.headers.location).toContain('ig_error=');
  });

  it('連結帳號、匯入舊留言（不自動回覆）、新留言依關鍵字規則自動回覆', async () => {
    const ctx = await createTestContext();
    const ig = fakeInstagram();
    ig.comments.push({ id: 'c-old', text: '請問價格多少？', timestamp: ago(120), username: 'old_fan', from: { id: 'u-old', username: 'old_fan' } });

    // 業主設定：留言提到「價格」就回覆固定內容
    const admin0 = await ctx.loginAs('admin');
    const rule = await admin0.post('/api/automation/rules').send({
      brandId: ctx.fx.brandA,
      name: '價格詢問自動回覆',
      action: 'auto_reply',
      matchType: 'keyword',
      keywords: ['價格', '多少錢'],
      replyTemplate: '{name} 你好～價格已經私訊給你囉！',
      categories: [],
      platforms: ['instagram'],
      minConfidence: 0.85,
      isActive: true,
    });
    expect(rule.status).toBe(201);
    expect(rule.body.matchType).toBe('keyword');

    const { admin, cb } = await connect(ctx);
    expect(cb.status).toBe(303);
    expect(cb.headers.location).toContain('ig=connected');

    const acct = await get<{ id: number; external_id: string; handle: string; brand_id: number }>(ctx.db, "SELECT * FROM social_accounts WHERE platform = 'instagram' AND external_id = ?", [IG_USER]);
    expect(acct?.handle).toBe('@shop_tw');
    expect(acct?.brand_id).toBe(ctx.fx.brandA);
    const cred = await get<{ access_token_enc: string }>(ctx.db, 'SELECT access_token_enc FROM account_credentials WHERE account_id = ?', [acct!.id]);
    expect(cred?.access_token_enc).not.toContain('long-token'); // 權杖加密保存

    // 連結前就存在的留言：匯入但不自動回覆
    const old = await get<{ id: number; status: string; author_name: string }>(ctx.db, "SELECT * FROM comments WHERE external_id = 'c-old'");
    expect(old?.author_name).toBe('@old_fan');
    expect(old?.status).toBe('pending');
    expect(ig.replies).toHaveLength(0);

    // 新留言：符合關鍵字 → 透過 Instagram API 自動回覆
    ig.comments.push({
      id: 'c-new',
      text: '這個價格多少呀',
      timestamp: new Date(Date.now() + 1000).toISOString(),
      username: 'buyer1',
      from: { id: 'u-1', username: 'buyer1' },
    });
    // 客訴即使有關鍵字也不自動回覆
    ig.comments.push({
      id: 'c-bad',
      text: '這價格品質這麼爛，我要退款',
      timestamp: new Date(Date.now() + 2000).toISOString(),
      username: 'angry',
      from: { id: 'u-2', username: 'angry' },
    });
    const sync = await admin.post(`/api/integrations/sync/${acct!.id}`);
    expect(sync.body.ok).toBe(true);
    expect(sync.body.newComments).toBe(2);
    expect(sync.body.autoReplied).toBe(1);
    expect(ig.replies).toEqual([{ commentId: 'c-new', message: 'buyer1 你好～價格已經私訊給你囉！', token: 'long-token' }]);
    const auto = await get<{ status: string; is_auto_handled: number }>(ctx.db, "SELECT status, is_auto_handled FROM comments WHERE external_id = 'c-new'");
    expect(auto?.is_auto_handled).toBe(1);
    const bad = await get<{ status: string; needs_human: number }>(ctx.db, "SELECT status, needs_human FROM comments WHERE external_id = 'c-bad'");
    expect(bad?.status).toBe('pending');

    // 品牌自己的回覆出現在留言串中，不會被當成新留言；重複同步不會重複處理
    ig.comments[1].replies = { data: [{ id: 'reply-1', text: 'buyer1 你好～價格已經私訊給你囉！', timestamp: new Date(Date.now() + 3000).toISOString(), username: 'shop_tw', parent_id: 'c-new' }] };
    const again = await admin.post(`/api/integrations/sync/${acct!.id}`);
    expect(again.body.newComments).toBe(0);
    expect(ig.replies).toHaveLength(1);

    // 人工在系統回覆客訴 → 送到 Instagram
    const badRow = await get<{ id: number }>(ctx.db, "SELECT id FROM comments WHERE external_id = 'c-bad'");
    const manual = await admin.post(`/api/comments/${badRow!.id}/reply`).send({ body: '很抱歉造成困擾，麻煩私訊訂單編號，我們會專人處理。', statusAfter: 'waiting' });
    expect(manual.status).toBe(201);
    expect(ig.replies[1]).toMatchObject({ commentId: 'c-bad', token: 'long-token' });

    // 隱藏留言走 Instagram API
    const hide = await admin.post(`/api/comments/${badRow!.id}/actions`).send({ action: 'hide' });
    expect(hide.status).toBe(200);
    expect(ig.hidden).toContain('c-bad');

    const logs = await all<{ action: string }>(ctx.db, "SELECT action FROM audit_logs WHERE action IN ('account.connect', 'comment.auto_reply')");
    expect(logs.map((l) => l.action).sort()).toEqual(['account.connect', 'comment.auto_reply']);
  });

  it('IG 上已經有本帳號回覆的留言，不會再自動回覆（避免重複回覆）', async () => {
    const ctx = await createTestContext();
    const ig = fakeInstagram();
    const admin0 = await ctx.loginAs('admin');
    await admin0.post('/api/automation/rules').send({
      brandId: ctx.fx.brandA, name: 'kw', action: 'auto_reply', matchType: 'keyword', keywords: ['價格'],
      replyTemplate: '已私訊你囉', categories: [], platforms: [], minConfidence: 0.85, isActive: true,
    });
    const { admin } = await connect(ctx);
    const acct = await get<{ id: number }>(ctx.db, "SELECT id FROM social_accounts WHERE platform = 'instagram'");
    const later = new Date(Date.now() + 1000).toISOString();
    ig.comments.push({
      id: 'c-dup', text: '請問價格', timestamp: later, username: 'buyer', from: { id: 'u-b', username: 'buyer' },
      replies: { data: [{ id: 'r-old', text: '已私訊你囉', timestamp: later, username: 'shop_tw', from: { id: IG_USER, username: 'shop_tw' }, parent_id: 'c-dup' }] },
    });
    const s1 = await admin.post(`/api/integrations/sync/${acct!.id}`);
    expect(s1.body.newComments).toBe(1);
    expect(s1.body.autoReplied).toBe(0);
    expect(ig.replies).toHaveLength(0);
  });

  it('連結前的舊留言不計時效；小編在 App 上的回覆不會被當成新留言，被回覆過的留言標示已完成', async () => {
    const ctx = await createTestContext();
    const ig = fakeInstagram();
    // 舊留言 A：小編已經在 App 上回覆（巢狀查詢沒有回傳作者，另外查也查不到）
    ig.comments.push({
      id: 'c-a', text: '跳得很好～', timestamp: ago(60 * 24 * 100), username: 'fan_a', from: { id: 'u-a', username: 'fan_a' },
      replies: { data: [{ id: 'r-own', text: '@fan_a 謝謝！', timestamp: ago(60 * 24 * 99), parent_id: 'c-a' }] },
    });
    // 舊留言 B：沒有人回覆
    ig.comments.push({ id: 'c-b', text: '後面對到', timestamp: ago(60 * 24 * 100), username: 'fan_b', from: { id: 'u-b', username: 'fan_b' } });
    // 舊留言 C：底下有別人的回覆（巢狀沒作者，但另外查得到）
    ig.comments.push({
      id: 'c-c', text: '老師好', timestamp: ago(60 * 24 * 90), username: 'fan_c', from: { id: 'u-c', username: 'fan_c' },
      replies: { data: [{ id: 'r-other', text: '+1', timestamp: ago(60 * 24 * 89), parent_id: 'c-c' }] },
    });
    ig.repliesOf['c-c'] = [{ id: 'r-other', text: '+1', timestamp: ago(60 * 24 * 89), username: 'fan_d', from: { id: 'u-d', username: 'fan_d' }, parent_id: 'c-c' }];
    await connect(ctx);

    const rows = await all<{ external_id: string; status: string; sla_due_at: string | null; first_response_type: string | null; author_name: string }>(
      ctx.db,
      "SELECT external_id, status, sla_due_at, first_response_type, author_name FROM comments WHERE external_id IN ('c-a', 'c-b', 'c-c', 'r-own', 'r-other') ORDER BY external_id",
    );
    const by = Object.fromEntries(rows.map((r) => [r.external_id, r]));
    expect(by['r-own']).toBeUndefined(); // 自己的回覆不是留言
    expect(by['c-a']).toMatchObject({ status: 'done', first_response_type: 'human', sla_due_at: null });
    expect(by['c-b']).toMatchObject({ status: 'pending', sla_due_at: null }); // 連結前的留言不計時效
    expect(by['r-other']).toMatchObject({ author_name: '@fan_d' });
    expect(ig.replies).toHaveLength(0);
  });

  it('修正已匯入的資料：自己的回覆改為無需處理、已在 App 回覆的留言改為已完成、舊留言取消時效', async () => {
    const ctx = await createTestContext();
    const ig = fakeInstagram();
    ig.comments.push({ id: 'c-x', text: '好看', timestamp: ago(60 * 24 * 30), username: 'fan_x', from: { id: 'u-x', username: 'fan_x' } });
    const { admin } = await connect(ctx);
    const acc = (await get<{ id: number }>(ctx.db, "SELECT id FROM social_accounts WHERE platform = 'instagram' AND external_id = ?", [IG_USER]))!;
    const post = (await get<{ id: number }>(ctx.db, 'SELECT post_id AS id FROM comments WHERE external_id = ?', ['c-x']))!;
    // 模擬舊版本匯入的錯誤資料：自己的回覆被當成留言、舊留言有時效
    const now = new Date().toISOString();
    await ctx.db.query(
      `INSERT INTO comments (brand_id, social_account_id, post_id, parent_comment_id, external_id, author_name, author_external_id, body, occurred_at, fetched_at, status, sla_due_at, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, 'r-mine', 'Instagram 使用者', '', '@fan_x 謝謝', $4, $4, 'pending', $4, $4, $4)`,
      [ctx.fx.brandA, acc.id, post.id, now],
    );
    await ctx.db.query("UPDATE comments SET sla_due_at = $1 WHERE external_id = 'c-x'", [now]);
    ig.comments[0].replies = { data: [{ id: 'r-mine', text: '@fan_x 謝謝', timestamp: ago(10), parent_id: 'c-x' }] };
    expect((await admin.post(`/api/integrations/sync/${acc.id}`)).status).toBe(200);
    const mine = await get<{ status: string }>(ctx.db, "SELECT status FROM comments WHERE external_id = 'r-mine'");
    const x = await get<{ status: string; first_response_at: string | null }>(ctx.db, "SELECT status, first_response_at FROM comments WHERE external_id = 'c-x'");
    expect(mine?.status).toBe('no_action');
    expect(x?.status).toBe('done');
    expect(x?.first_response_at).not.toBeNull();
  });

  it('留言在 IG 上被刪除：同步後標示已刪除、不再待處理；回覆時平台找不到留言也會標示', async () => {
    const ctx = await createTestContext();
    const ig = fakeInstagram();
    ig.comments.push({ id: 'c-del', text: '你知道綠豆跌倒會變什麼嗎', timestamp: ago(30), username: 'fan_y', from: { id: 'u-y', username: 'fan_y' } });
    ig.comments.push({ id: 'c-del2', text: '高雄有幾個人', timestamp: ago(20), username: 'fan_z', from: { id: 'u-z', username: 'fan_z' } });
    const { admin } = await connect(ctx);
    const acc = (await get<{ id: number }>(ctx.db, "SELECT id FROM social_accounts WHERE platform = 'instagram' AND external_id = ?", [IG_USER]))!;
    ig.comments.splice(0, 1); // c-del 被留言者刪除
    expect((await admin.post(`/api/integrations/sync/${acc.id}`)).status).toBe(200);
    const del = await get<{ visibility: string; status: string }>(ctx.db, "SELECT visibility, status FROM comments WHERE external_id = 'c-del'");
    expect(del).toMatchObject({ visibility: 'deleted', status: 'no_action' });
    expect(await get(ctx.db, "SELECT id FROM audit_logs WHERE action = 'comment.deleted_on_platform'")).toBeTruthy();

    // 回覆時平台回傳找不到留言
    setInstagramFetch(async () => new Response(JSON.stringify({ error: { message: "Unsupported post request. Object with ID 'c-del2' does not exist", code: 100 } }), { status: 400 }));
    const c2 = (await get<{ id: number }>(ctx.db, "SELECT id FROM comments WHERE external_id = 'c-del2'"))!;
    const res = await admin.post(`/api/comments/${c2.id}/reply`).send({ body: '謝謝留言', statusAfter: 'done' });
    expect(res.status).toBe(410);
    expect(await get(ctx.db, 'SELECT visibility, status FROM comments WHERE id = ?', [c2.id])).toMatchObject({ visibility: 'deleted', status: 'no_action' });
  });

  it('Webhook：驗證權杖、檢查簽章、收到通知後同步', async () => {
    const ctx = await createTestContext();
    const ig = fakeInstagram();
    await connect(ctx);
    const request = (await import('supertest')).default;

    const verify = await request(ctx.app).get('/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
    expect(verify.text).toBe('12345');
    const wrong = await request(ctx.app).get('/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1');
    expect(wrong.status).toBe(403);

    const payload = JSON.stringify({ object: 'instagram', entry: [{ id: IG_USER, time: 1, changes: [{ field: 'comments', value: { id: 'c-hook', text: 'hi' } }] }] });
    const unsigned = await request(ctx.app).post('/api/webhooks/instagram').set('Content-Type', 'application/json').send(payload);
    expect(unsigned.status).toBe(401);

    ig.comments.push({ id: 'c-hook', text: '好漂亮！', timestamp: new Date(Date.now() + 1000).toISOString(), username: 'fan', from: { id: 'u-9', username: 'fan' } });
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(payload).digest('hex')}`;
    const ok = await request(ctx.app).post('/api/webhooks/instagram').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(payload);
    expect(ok.status).toBe(200);
    expect(await get(ctx.db, "SELECT id FROM comments WHERE external_id = 'c-hook'")).toBeTruthy();
  });

  it('關鍵字規則：缺少回覆內容或含禁用詞會被拒絕', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    const base = { brandId: ctx.fx.brandA, name: 'kw', action: 'auto_reply', matchType: 'keyword', categories: [], platforms: [], minConfidence: 0.85, isActive: true };
    expect((await admin.post('/api/automation/rules').send({ ...base, keywords: ['價格'], replyTemplate: '' })).status).toBe(400);
    expect((await admin.post('/api/automation/rules').send({ ...base, keywords: [], replyTemplate: 'hi' })).status).toBe(400);
  });
});
