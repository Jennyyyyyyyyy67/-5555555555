import request from 'supertest';
import { createTestContext } from '../test/helpers';
import { all, get, insert, run } from '../db';

type AuditRow = { action: string; brand_id: number | null; actor_user_id: number | null; target_id: number | null; summary: string; detail: string | null };
const auditRows = (ctx: ReturnType<typeof createTestContext>, prefix = 'account.') =>
  all<AuditRow>(ctx.db, `SELECT action, brand_id, actor_user_id, target_id, summary, detail FROM audit_logs WHERE action LIKE ? ORDER BY id`, [
    `${prefix}%`,
  ]);

const validInput = (brandId: number, extra: Record<string, unknown> = {}) => ({
  brandId,
  platform: 'instagram',
  accountType: 'ig_account',
  name: '日日咖啡 IG',
  handle: '@dailycoffee.tw',
  externalId: 'ig-123',
  ...extra,
});

describe('社群帳號：查看權限與品牌隔離', () => {
  it('未登入回傳 401', async () => {
    const ctx = createTestContext();
    expect((await request(ctx.app).get('/api/accounts')).status).toBe(401);
  });

  it('管理員可看到全部品牌的帳號，含貼文與留言數', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.get('/api/accounts');
    expect(res.status).toBe(200);
    expect(res.body.map((a: { id: number }) => a.id)).toEqual([ctx.fx.accountA, ctx.fx.accountB]);
    const a = res.body[0];
    expect(a).toMatchObject({ brandId: ctx.fx.brandA, brandName: '品牌甲', platform: 'facebook', accountType: 'fb_page', postCount: 1, commentCount: 1, isActive: true });
  });

  it('管理員可看到已停用品牌的帳號', async () => {
    const ctx = createTestContext();
    run(ctx.db, 'UPDATE brands SET is_active = 0 WHERE id = ?', [ctx.fx.brandB]);
    const agent = await ctx.loginAs('admin');
    const res = await agent.get('/api/accounts');
    expect(res.body.map((a: { id: number }) => a.id)).toContain(ctx.fx.accountB);
  });

  it('主管只能看到自己負責品牌的帳號', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('sup');
    const res = await agent.get('/api/accounts');
    expect(res.status).toBe(200);
    expect(res.body.map((a: { brandId: number }) => a.brandId)).toEqual([ctx.fx.brandA]);
  });

  it('主管指定其他品牌 ?brand= 回傳 403', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('sup');
    const res = await agent.get('/api/accounts').query({ brand: ctx.fx.brandB });
    expect(res.status).toBe(403);
  });

  it('主管以 id 讀取其他品牌的帳號回傳 404', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('sup');
    expect((await agent.get(`/api/accounts/${ctx.fx.accountA}`)).status).toBe(200);
    const res = await agent.get(`/api/accounts/${ctx.fx.accountB}`);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('找不到社群帳號');
  });

  it('不存在或格式錯誤的 id 回傳 404', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    expect((await agent.get('/api/accounts/9999')).status).toBe(404);
    expect((await agent.get('/api/accounts/abc')).status).toBe(404);
  });

  it('操作人員無法查看社群帳號（403）', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('opA');
    expect((await agent.get('/api/accounts')).status).toBe(403);
    expect((await agent.get(`/api/accounts/${ctx.fx.accountA}`)).status).toBe(403);
  });

  it('可依品牌與平台篩選', async () => {
    const ctx = createTestContext();
    const now = '2026-01-01T00:00:00.000Z';
    insert(ctx.db, 'social_accounts', {
      brand_id: ctx.fx.brandA, platform: 'youtube', account_type: 'yt_channel', name: '甲頻道',
      external_id: 'yt-a', adapter_key: 'mock:youtube', created_at: now, updated_at: now,
    });
    const agent = await ctx.loginAs('admin');
    const byBrand = await agent.get('/api/accounts').query({ brand: ctx.fx.brandA });
    expect(byBrand.body.map((a: { platform: string }) => a.platform)).toEqual(['facebook', 'youtube']);
    const byPlatform = await agent.get('/api/accounts').query({ platform: 'youtube' });
    expect(byPlatform.body).toHaveLength(1);
    expect(byPlatform.body[0].name).toBe('甲頻道');
  });
});

describe('社群帳號：新增', () => {
  it('管理員新增帳號後自動測試連線，狀態為已連線並寫入 2 筆操作紀錄', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/accounts').send(validInput(ctx.fx.brandA));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      brandId: ctx.fx.brandA,
      brandName: '品牌甲',
      platform: 'instagram',
      accountType: 'ig_account',
      name: '日日咖啡 IG',
      handle: '@dailycoffee.tw',
      externalId: 'ig-123',
      adapterKey: 'mock:instagram',
      status: 'connected',
      isActive: true,
      postCount: 0,
      commentCount: 0,
    });
    expect(res.body.lastCheckedAt).toBeTruthy();
    expect(res.body.connection.ok).toBe(true);
    expect(res.body.connection.message).toContain('模擬連線成功');

    const logs = auditRows(ctx);
    expect(logs.map((l) => l.action)).toEqual(['account.create', 'account.test_connection']);
    for (const l of logs) {
      expect(l.brand_id).toBe(ctx.fx.brandA);
      expect(l.actor_user_id).toBe(ctx.fx.admin);
      expect(l.target_id).toBe(res.body.id);
    }
    expect(logs[0].summary).toContain('日日咖啡 IG');
    expect(JSON.parse(logs[1].detail!)).toMatchObject({ ok: true });
  });

  it('平台帳號 ID 以 err- 開頭時連線測試失敗，狀態為連線異常', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/accounts').send(validInput(ctx.fx.brandB, { externalId: 'err-expired' }));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('error');
    expect(res.body.connection.ok).toBe(false);
    expect(res.body.connection.message).toContain('模擬連線失敗');
    const test = auditRows(ctx, 'account.test_connection');
    expect(test).toHaveLength(1);
    expect(JSON.parse(test[0].detail!)).toMatchObject({ ok: false });
  });

  it('不支援的平台、帳號類型與平台不符時回傳 400', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const unknown = await agent.post('/api/accounts').send(validInput(ctx.fx.brandA, { platform: 'tiktok' }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toContain('不支援的平台');
    const mismatch = await agent.post('/api/accounts').send(validInput(ctx.fx.brandA, { platform: 'google', accountType: 'fb_page' }));
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.message).toContain('此平台不支援這種帳號類型');
    expect(auditRows(ctx)).toHaveLength(0);
  });

  it('欄位格式錯誤回傳 400', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    expect((await agent.post('/api/accounts').send(validInput(ctx.fx.brandA, { name: '  ' }))).status).toBe(400);
    expect((await agent.post('/api/accounts').send(validInput(ctx.fx.brandA, { name: 'x'.repeat(61) }))).status).toBe(400);
    expect((await agent.post('/api/accounts').send(validInput(ctx.fx.brandA, { handle: 'x'.repeat(61) }))).status).toBe(400);
    expect((await agent.post('/api/accounts').send(validInput(ctx.fx.brandA, { externalId: '' }))).status).toBe(400);
    expect((await agent.post('/api/accounts').send(validInput(ctx.fx.brandA, { externalId: 'x'.repeat(121) }))).status).toBe(400);
    expect((await agent.post('/api/accounts').send(validInput(ctx.fx.brandA, { brandId: 'abc' }))).status).toBe(400);
    const missing = await agent.post('/api/accounts').send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toContain('請選擇品牌');

    // 共用錯誤處理：直接使用欄位的中文訊息（不夾帶英文欄位名稱），並標出欄位供表單顯示
    const blankName = await agent.post('/api/accounts').send(validInput(ctx.fx.brandA, { name: '  ' }));
    expect(blankName.body.error.code).toBe('validation_error');
    expect(blankName.body.error.message).toBe('請輸入帳號名稱');
    expect(blankName.body.error.details.field).toBe('name');
  });

  it('品牌已停用時回傳 400；品牌不存在時回傳 404', async () => {
    const ctx = createTestContext();
    run(ctx.db, 'UPDATE brands SET is_active = 0 WHERE id = ?', [ctx.fx.brandB]);
    const agent = await ctx.loginAs('admin');
    const inactive = await agent.post('/api/accounts').send(validInput(ctx.fx.brandB));
    expect(inactive.status).toBe(400);
    expect(inactive.body.error.message).toContain('品牌已停用，無法新增社群帳號');
    expect((await agent.post('/api/accounts').send(validInput(9999))).status).toBe(404);
  });

  it('同一平台帳號重複綁定回傳 409 並說明已綁定的品牌', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/accounts').send(validInput(ctx.fx.brandB, { platform: 'facebook', accountType: 'fb_page', externalId: 'fx-a' }));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('此平台帳號已綁定在品牌「品牌甲」');
    // 不同平台可使用相同的 ID
    const other = await agent.post('/api/accounts').send(validInput(ctx.fx.brandB, { externalId: 'fx-a' }));
    expect(other.status).toBe(201);
  });

  it('主管與操作人員無法新增（403）', async () => {
    const ctx = createTestContext();
    const sup = await ctx.loginAs('sup');
    expect((await sup.post('/api/accounts').send(validInput(ctx.fx.brandA))).status).toBe(403);
    const op = await ctx.loginAs('opA');
    expect((await op.post('/api/accounts').send(validInput(ctx.fx.brandA))).status).toBe(403);
    expect(get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM social_accounts')!.n).toBe(2);
  });
});

describe('社群帳號：編輯與停用', () => {
  it('可修改名稱與代稱並寫入操作紀錄；沒有變動時不寫紀錄', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.patch(`/api/accounts/${ctx.fx.accountA}`).send({ name: '品牌甲官方粉專', handle: '@brand.a' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: '品牌甲官方粉專', handle: '@brand.a' });
    const logs = auditRows(ctx);
    expect(logs.map((l) => l.action)).toEqual(['account.update']);
    expect(logs[0].summary).toContain('品牌甲官方粉專');

    const same = await agent.patch(`/api/accounts/${ctx.fx.accountA}`).send({ name: '品牌甲官方粉專', handle: '@brand.a', isActive: true });
    expect(same.status).toBe(200);
    expect(auditRows(ctx)).toHaveLength(1);
  });

  it('停用與啟用寫入操作紀錄', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const off = await agent.patch(`/api/accounts/${ctx.fx.accountB}`).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    const on = await agent.patch(`/api/accounts/${ctx.fx.accountB}`).send({ isActive: true });
    expect(on.body.isActive).toBe(true);
    const logs = auditRows(ctx);
    expect(logs.map((l) => l.action)).toEqual(['account.deactivate', 'account.activate']);
    expect(logs[0].brand_id).toBe(ctx.fx.brandB);
    expect(logs[0].summary).toContain('停用');
  });

  it('不可更換品牌、平台、帳號類型或平台帳號 ID（400）', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    for (const body of [{ brandId: ctx.fx.brandB }, { platform: 'instagram' }, { accountType: 'fb_group' }, { externalId: 'new-id' }]) {
      const res = await agent.patch(`/api/accounts/${ctx.fx.accountA}`).send({ name: '新名稱', ...body });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('社群帳號建立後不可更換品牌或平台');
    }
    const row = get<{ brand_id: number; name: string }>(ctx.db, 'SELECT brand_id, name FROM social_accounts WHERE id = ?', [ctx.fx.accountA]);
    expect(row).toMatchObject({ brand_id: ctx.fx.brandA, name: '粉專 fx-a' });
    expect(auditRows(ctx)).toHaveLength(0);
  });

  it('名稱空白回傳 400', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    expect((await agent.patch(`/api/accounts/${ctx.fx.accountA}`).send({ name: ' ' })).status).toBe(400);
    expect((await agent.patch(`/api/accounts/${ctx.fx.accountA}`).send({ isActive: 'no' })).status).toBe(400);
  });

  it('主管無法編輯（403）', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('sup');
    expect((await agent.patch(`/api/accounts/${ctx.fx.accountA}`).send({ name: 'x' })).status).toBe(403);
    expect((await agent.patch(`/api/accounts/${ctx.fx.accountA}`).send({ isActive: false })).status).toBe(403);
  });

  it('不存在的帳號回傳 404', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    expect((await agent.patch('/api/accounts/9999').send({ name: 'x' })).status).toBe(404);
  });
});

describe('社群帳號：測試連線', () => {
  it('測試成功更新狀態與最後檢查時間並寫入紀錄', async () => {
    const ctx = createTestContext();
    run(ctx.db, "UPDATE social_accounts SET status = 'disconnected' WHERE id = ?", [ctx.fx.accountA]);
    const agent = await ctx.loginAs('admin');
    const res = await agent.post(`/api/accounts/${ctx.fx.accountA}/test`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain('模擬連線成功');
    expect(res.body.account).toMatchObject({ id: ctx.fx.accountA, status: 'connected' });
    expect(res.body.account.lastCheckedAt).toBeTruthy();
    const logs = auditRows(ctx);
    expect(logs.map((l) => l.action)).toEqual(['account.test_connection']);
    expect(JSON.parse(logs[0].detail!)).toEqual({ ok: true, message: res.body.message });
  });

  it('err- 開頭的帳號測試失敗，狀態改為連線異常', async () => {
    const ctx = createTestContext();
    run(ctx.db, "UPDATE social_accounts SET external_id = 'err-a' WHERE id = ?", [ctx.fx.accountA]);
    const agent = await ctx.loginAs('admin');
    const res = await agent.post(`/api/accounts/${ctx.fx.accountA}/test`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.account.status).toBe('error');
  });

  it('主管無法測試連線（403）', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('sup');
    expect((await agent.post(`/api/accounts/${ctx.fx.accountA}/test`)).status).toBe(403);
    expect(auditRows(ctx)).toHaveLength(0);
  });

  it('沒有刪除 API', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    expect((await agent.delete(`/api/accounts/${ctx.fx.accountA}`)).status).toBe(404);
    expect(get(ctx.db, 'SELECT id FROM social_accounts WHERE id = ?', [ctx.fx.accountA])).toBeTruthy();
  });
});
