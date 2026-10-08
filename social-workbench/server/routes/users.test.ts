import { createTestContext } from '../test/helpers';
import { all, get, insert, run } from '../db';
import { hashPassword } from '../auth/password';
import { FIXTURE_PASSWORD } from '../test/fixture';
import type { UserRow } from '../../shared/types';

type AuditRow = { action: string; summary: string; before: string | null; after: string | null; detail: string | null; actor_user_id: number | null; target_id: number | null };

const auditRows = async (ctx: Awaited<ReturnType<typeof createTestContext>>, action: string) =>
  await all<AuditRow>(ctx.db, 'SELECT action, summary, before, after, detail, actor_user_id, target_id FROM audit_logs WHERE action = ? ORDER BY id', [action]);

const byId = (rows: UserRow[], id: number) => rows.find((u) => u.id === id);

const NEW_USER = { name: '新同事', email: 'New.Person@Test.tw', role: 'operator', password: 'secret-pass-1', brandIds: [] as number[] };

describe('人員列表 GET /api/users', () => {
  it('管理員可看到所有人員，管理員的 brandIds 為空陣列，並依啟用、角色、姓名排序', async () => {
    const ctx = await createTestContext();
    await run(ctx.db, 'UPDATE users SET is_active = 0 WHERE id = ?', [ctx.fx.opB]);
    const agent = await ctx.loginAs('admin');
    const res = await agent.get('/api/users');
    expect(res.status).toBe(200);
    const rows = res.body as UserRow[];
    expect(rows.map((u) => u.id)).toEqual([ctx.fx.admin, ctx.fx.sup, ctx.fx.opA, ctx.fx.opB]);
    expect(byId(rows, ctx.fx.admin)!.brandIds).toEqual([]);
    expect(byId(rows, ctx.fx.opB)!.isActive).toBe(false);
    expect(byId(rows, ctx.fx.opA)!.brandIds).toEqual([ctx.fx.brandA]);
    // 不可回傳密碼雜湊
    expect(JSON.stringify(res.body)).not.toContain('scrypt');
    expect(rows[0]).not.toHaveProperty('passwordHash');
  });

  it('管理員指定品牌時，只列出管理員與被授權該品牌的人員', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.get('/api/users').query({ brand: ctx.fx.brandB });
    expect(res.status).toBe(200);
    expect((res.body as UserRow[]).map((u) => u.id).sort()).toEqual([ctx.fx.admin, ctx.fx.opB].sort());
  });

  it('主管只看到與負責品牌相關的非管理員人員，且授權品牌只顯示自己範圍內的部分', async () => {
    const ctx = await createTestContext();
    // opA 同時被授權品牌甲與品牌乙；主管只負責品牌甲
    await run(ctx.db, 'INSERT INTO user_brands (user_id, brand_id, created_at) VALUES (?, ?, ?)', [ctx.fx.opA, ctx.fx.brandB, '2026-01-01T00:00:00.000Z']);
    const agent = await ctx.loginAs('sup');
    const res = await agent.get('/api/users');
    expect(res.status).toBe(200);
    const rows = res.body as UserRow[];
    expect(rows.map((u) => u.id).sort()).toEqual([ctx.fx.sup, ctx.fx.opA].sort());
    expect(byId(rows, ctx.fx.opA)!.brandIds).toEqual([ctx.fx.brandA]);
    expect(byId(rows, ctx.fx.admin)).toBeUndefined();
    expect(byId(rows, ctx.fx.opB)).toBeUndefined();
  });

  it('主管指定範圍外的品牌回傳 403', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('sup');
    const res = await agent.get('/api/users').query({ brand: ctx.fx.brandB });
    expect(res.status).toBe(403);
  });

  it('操作人員無法查看人員列表（403）', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('opA');
    const res = await agent.get('/api/users');
    expect(res.status).toBe(403);
  });
});

describe('人員名錄 GET /api/users/directory', () => {
  it('必須指定品牌（400）', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('opA');
    const res = await agent.get('/api/users/directory');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('品牌');
  });

  it('不可查詢範圍外的品牌（403）', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('opA');
    const res = await agent.get('/api/users/directory').query({ brand: ctx.fx.brandB });
    expect(res.status).toBe(403);
  });

  it('回傳管理員與被授權的啟用中人員，只含最少欄位，排除停用人員', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('opA');
    const before = await agent.get('/api/users/directory').query({ brand: ctx.fx.brandA });
    expect(before.status).toBe(200);
    expect(before.body).toEqual([
      { id: ctx.fx.admin, name: '管理員', role: 'admin' },
      { id: ctx.fx.sup, name: '主管', role: 'supervisor' },
      { id: ctx.fx.opA, name: '甲操作', role: 'operator' },
    ]);

    await run(ctx.db, 'UPDATE users SET is_active = 0 WHERE id = ?', [ctx.fx.sup]);
    const after = await agent.get('/api/users/directory').query({ brand: ctx.fx.brandA });
    expect(after.body.map((u: { id: number }) => u.id)).toEqual([ctx.fx.admin, ctx.fx.opA]);
  });
});

describe('新增人員 POST /api/users', () => {
  it('管理員可新增人員，Email 轉小寫，寫入授權品牌與操作紀錄（不含密碼）', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/users').send({ ...NEW_USER, brandIds: [ctx.fx.brandB, ctx.fx.brandA, ctx.fx.brandA] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: '新同事', email: 'new.person@test.tw', role: 'operator', isActive: true, lastLoginAt: null });
    expect(res.body.brandIds).toEqual([ctx.fx.brandA, ctx.fx.brandB]);

    const logs = await auditRows(ctx, 'user.create');
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_user_id).toBe(ctx.fx.admin);
    expect(logs[0].target_id).toBe(res.body.id);
    expect(logs[0].summary).toContain('新同事');
    const after = JSON.parse(logs[0].after!);
    expect(after).toMatchObject({ name: '新同事', email: 'new.person@test.tw', role: '操作人員', brands: ['品牌甲', '品牌乙'] });
    const raw = JSON.stringify(logs[0]);
    expect(raw).not.toContain(NEW_USER.password);
    expect(raw.toLowerCase()).not.toContain('password');

    // 新人員可用該密碼登入
    const newAgent = await ctx.loginWith('new.person@test.tw', NEW_USER.password);
    expect((await newAgent.get('/api/auth/me')).body.brands).toHaveLength(2);
  });

  it('角色為管理員時忽略授權品牌', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/users').send({ ...NEW_USER, role: 'admin', brandIds: [ctx.fx.brandA] });
    expect(res.status).toBe(201);
    expect(res.body.brandIds).toEqual([]);
    expect(await all(ctx.db, 'SELECT * FROM user_brands WHERE user_id = ?', [res.body.id])).toHaveLength(0);
  });

  it.each([
    ['密碼太短', { password: 'short' }, '密碼至少需要 8 個字元'],
    ['Email 格式錯誤', { email: 'not-an-email' }, 'Email 格式不正確'],
    ['姓名空白', { name: '   ' }, '請輸入姓名'],
    ['角色不存在', { role: 'owner' }, '請選擇角色'],
  ])('輸入驗證：%s → 400', async (_label, override, message) => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/users').send({ ...NEW_USER, ...override });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(message);
    expect(await auditRows(ctx, 'user.create')).toHaveLength(0);
  });

  it('授權品牌不存在 → 400', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/users').send({ ...NEW_USER, brandIds: [ctx.fx.brandA, 9999] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe('brandIds');
    expect(await get(ctx.db, 'SELECT id FROM users WHERE email = ?', ['new.person@test.tw'])).toBeUndefined();
  });

  it('Email 重複（不分大小寫）→ 409', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/users').send({ ...NEW_USER, email: 'OPA@Test.TW' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('此 Email 已被使用');
  });

  it('主管與操作人員無法新增人員（403）', async () => {
    const ctx = await createTestContext();
    for (const who of ['sup', 'opA'] as const) {
      const agent = await ctx.loginAs(who);
      const res = await agent.post('/api/users').send(NEW_USER);
      expect(res.status).toBe(403);
    }
  });
});

describe('編輯人員 PATCH /api/users/:id', () => {
  it('調整角色與授權品牌時寫入 permissions_change 紀錄（品牌名稱與角色名稱）', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.patch(`/api/users/${ctx.fx.opA}`).send({ role: 'supervisor', brandIds: [ctx.fx.brandA, ctx.fx.brandB] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: 'supervisor', brandIds: [ctx.fx.brandA, ctx.fx.brandB] });

    const logs = await auditRows(ctx, 'user.permissions_change');
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0].before!)).toEqual({ role: '操作人員', brands: ['品牌甲'] });
    expect(JSON.parse(logs[0].after!)).toEqual({ role: '主管', brands: ['品牌甲', '品牌乙'] });
    expect(logs[0].summary).toContain('甲操作');

    // 權限立即生效
    const opA = await ctx.loginAs('opA');
    expect((await opA.get('/api/users')).status).toBe(200);
  });

  it('只改姓名時寫入 user.update；沒有任何變動時不寫紀錄', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.patch(`/api/users/${ctx.fx.opB}`).send({ name: '  乙小編 ' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('乙小編');
    const logs = await auditRows(ctx, 'user.update');
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0].before!)).toEqual({ name: '乙操作' });
    expect(JSON.parse(logs[0].after!)).toEqual({ name: '乙小編' });

    const noop = await agent
      .patch(`/api/users/${ctx.fx.opB}`)
      .send({ name: '乙小編', role: 'operator', brandIds: [ctx.fx.brandB], isActive: true, email: 'OPB@test.tw' });
    expect(noop.status).toBe(200);
    const count = (await get<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'user.%'"))!.n;
    expect(count).toBe(1);
  });

  it('Email 建立後不可修改（400）', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.patch(`/api/users/${ctx.fx.opB}`).send({ email: 'other@test.tw' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Email 建立後不可修改');
  });

  it('改為管理員時移除授權品牌列', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.patch(`/api/users/${ctx.fx.sup}`).send({ role: 'admin', brandIds: [ctx.fx.brandB] });
    expect(res.status).toBe(200);
    expect(res.body.brandIds).toEqual([]);
    expect(await all(ctx.db, 'SELECT * FROM user_brands WHERE user_id = ?', [ctx.fx.sup])).toHaveLength(0);
  });

  it('授權品牌不存在 → 400，不變動資料', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.patch(`/api/users/${ctx.fx.opA}`).send({ brandIds: [9999] });
    expect(res.status).toBe(400);
    expect(await all(ctx.db, 'SELECT brand_id FROM user_brands WHERE user_id = ?', [ctx.fx.opA])).toEqual([{ brand_id: ctx.fx.brandA }]);
  });

  it('找不到人員 → 404', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    expect((await agent.patch('/api/users/9999').send({ name: 'x' })).status).toBe(404);
    expect((await agent.patch('/api/users/abc').send({ name: 'x' })).status).toBe(404);
  });

  it('主管無法編輯人員（403）', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('sup');
    const res = await agent.patch(`/api/users/${ctx.fx.opA}`).send({ brandIds: [ctx.fx.brandA, ctx.fx.brandB] });
    expect(res.status).toBe(403);
  });

  it('唯一的啟用中管理員不能被降級或停用', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('admin');
    for (const body of [{ role: 'operator' }, { isActive: false }]) {
      const res = await agent.patch(`/api/users/${ctx.fx.admin}`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('系統至少需要一位啟用中的管理員');
    }
    expect(await get<{ role: string; is_active: number }>(ctx.db, 'SELECT role, is_active FROM users WHERE id = ?', [ctx.fx.admin])).toEqual({
      role: 'admin',
      is_active: 1,
    });
  });

  it('管理員不能停用自己或變更自己的角色（即使還有其他管理員）', async () => {
    const ctx = await createTestContext();
    const now = '2026-01-01T00:00:00.000Z';
    await insert(ctx.db, 'users', { name: '第二位管理員', email: 'admin2@test.tw', role: 'admin', password_hash: hashPassword(FIXTURE_PASSWORD), created_at: now, updated_at: now });
    const agent = await ctx.loginAs('admin');
    const deactivate = await agent.patch(`/api/users/${ctx.fx.admin}`).send({ isActive: false });
    expect(deactivate.status).toBe(400);
    expect(deactivate.body.error.message).toContain('不能停用自己的帳號');
    const demote = await agent.patch(`/api/users/${ctx.fx.admin}`).send({ role: 'supervisor' });
    expect(demote.status).toBe(400);
    expect(demote.body.error.message).toContain('不能變更自己的角色');
    // 改自己的姓名可以
    const rename = await agent.patch(`/api/users/${ctx.fx.admin}`).send({ name: '系統管理員' });
    expect(rename.status).toBe(200);
  });

  it('還有其他管理員時，可停用另一位管理員', async () => {
    const ctx = await createTestContext();
    const now = '2026-01-01T00:00:00.000Z';
    const admin2 = await insert(ctx.db, 'users', { name: '第二位管理員', email: 'admin2@test.tw', role: 'admin', password_hash: hashPassword(FIXTURE_PASSWORD), created_at: now, updated_at: now });
    const agent = await ctx.loginAs('admin');
    const res = await agent.patch(`/api/users/${admin2}`).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
  });

  it('停用後該人員的登入狀態立即失效，並寫入停用／啟用紀錄', async () => {
    const ctx = await createTestContext();
    const opB = await ctx.loginAs('opB');
    expect((await opB.get('/api/auth/me')).status).toBe(200);
    const admin = await ctx.loginAs('admin');
    const res = await admin.patch(`/api/users/${ctx.fx.opB}`).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(await all(ctx.db, 'SELECT * FROM sessions WHERE user_id = ?', [ctx.fx.opB])).toHaveLength(0);
    expect((await opB.get('/api/auth/me')).status).toBe(401);
    expect(await auditRows(ctx, 'user.deactivate')).toHaveLength(1);

    const reactivate = await admin.patch(`/api/users/${ctx.fx.opB}`).send({ isActive: true });
    expect(reactivate.body.isActive).toBe(true);
    expect(await auditRows(ctx, 'user.activate')).toHaveLength(1);
    // 舊 session 不會復活，需要重新登入
    expect((await opB.get('/api/auth/me')).status).toBe(401);
    expect((await (await ctx.loginAs('opB')).get('/api/auth/me')).status).toBe(200);
  });
});

describe('重設密碼 POST /api/users/:id/reset-password', () => {
  it('重設後舊密碼失效、新密碼可登入、既有 session 被登出，紀錄不含密碼', async () => {
    const ctx = await createTestContext();
    const opA = await ctx.loginAs('opA');
    const admin = await ctx.loginAs('admin');
    const res = await admin.post(`/api/users/${ctx.fx.opA}/reset-password`).send({ password: 'brand-new-pass' });
    expect(res.status).toBe(204);

    expect((await opA.get('/api/auth/me')).status).toBe(401);
    await expect(ctx.loginWith('opa@test.tw', FIXTURE_PASSWORD)).rejects.toThrow();
    const relogin = await ctx.loginWith('opa@test.tw', 'brand-new-pass');
    expect((await relogin.get('/api/auth/me')).status).toBe(200);

    const logs = await auditRows(ctx, 'user.reset_password');
    expect(logs).toHaveLength(1);
    expect(logs[0].target_id).toBe(ctx.fx.opA);
    const raw = JSON.stringify(logs[0]);
    expect(raw).not.toContain('brand-new-pass');
    expect(raw.toLowerCase()).not.toContain('"password');
  });

  it('管理員重設自己的密碼時，保留目前登入狀態、登出其他裝置', async () => {
    const ctx = await createTestContext();
    const other = await ctx.loginAs('admin');
    const current = await ctx.loginAs('admin');
    const res = await current.post(`/api/users/${ctx.fx.admin}/reset-password`).send({ password: 'my-new-password' });
    expect(res.status).toBe(204);
    expect((await current.get('/api/auth/me')).status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(401);
  });

  it('密碼太短 → 400；主管 → 403；找不到 → 404', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    const short = await admin.post(`/api/users/${ctx.fx.opA}/reset-password`).send({ password: '1234' });
    expect(short.status).toBe(400);
    expect(short.body.error.details.field).toBe('password');
    expect((await admin.post('/api/users/9999/reset-password').send({ password: 'long-enough-1' })).status).toBe(404);
    const sup = await ctx.loginAs('sup');
    expect((await sup.post(`/api/users/${ctx.fx.opA}/reset-password`).send({ password: 'long-enough-1' })).status).toBe(403);
    expect(await auditRows(ctx, 'user.reset_password')).toHaveLength(0);
  });
});
