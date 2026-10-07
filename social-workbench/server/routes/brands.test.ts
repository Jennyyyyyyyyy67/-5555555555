import request from 'supertest';
import { createTestContext } from '../test/helpers';
import { all, get, insert, run } from '../db';
import { DEFAULT_CATEGORIES } from '../../shared/constants';
import type { Brand } from '../../shared/types';

type AuditRow = { action: string; actor_user_id: number | null; brand_id: number | null; summary: string; before: string | null; after: string | null };
const auditRows = (ctx: ReturnType<typeof createTestContext>, actionLike = 'brand.%') =>
  all<AuditRow>(ctx.db, 'SELECT action, actor_user_id, brand_id, summary, before, after FROM audit_logs WHERE action LIKE ? ORDER BY id', [actionLike]);

const validInput = { name: '新品牌', code: 'new-1', color: '#AABBCC', description: '測試用品牌', nearDueMinutes: 20 };

describe('GET /api/brands', () => {
  it('管理員看到全部品牌（含停用）與統計數字，啟用中排前面', async () => {
    const ctx = createTestContext();
    run(ctx.db, 'UPDATE brands SET is_active = 0 WHERE id = ?', [ctx.fx.brandA]);
    // 管理員本身的授權、已停用人員都不列入授權人員數
    run(ctx.db, 'INSERT INTO user_brands (user_id, brand_id, created_at) VALUES (?, ?, ?)', [ctx.fx.admin, ctx.fx.brandB, '2026-01-01']);
    const inactiveOp = insert(ctx.db, 'users', {
      name: '離職', email: 'gone@test.tw', role: 'operator', password_hash: 'x', is_active: false, created_at: '2026-01-01', updated_at: '2026-01-01',
    });
    run(ctx.db, 'INSERT INTO user_brands (user_id, brand_id, created_at) VALUES (?, ?, ?)', [inactiveOp, ctx.fx.brandB, '2026-01-01']);

    const agent = await ctx.loginAs('admin');
    const res = await agent.get('/api/brands');
    expect(res.status).toBe(200);
    const list = res.body as Brand[];
    expect(list.map((b) => b.id)).toEqual([ctx.fx.brandB, ctx.fx.brandA]);
    const a = list.find((b) => b.id === ctx.fx.brandA)!;
    const b = list.find((x) => x.id === ctx.fx.brandB)!;
    expect(a.isActive).toBe(false);
    expect(a).toMatchObject({ accountCount: 1, userCount: 2, commentCount: 1, nearDueMinutes: 15, code: 'BA' });
    expect(b).toMatchObject({ accountCount: 1, userCount: 1, commentCount: 1, isActive: true });
  });

  it('操作人員只看到自己被授權且啟用中的品牌，且沒有統計欄位', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('opA');
    const res = await agent.get('/api/brands');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(ctx.fx.brandA);
    expect(res.body[0]).not.toHaveProperty('accountCount');
    expect(res.body[0]).not.toHaveProperty('userCount');
    expect(res.body[0]).not.toHaveProperty('commentCount');
  });

  it('未登入回傳 401', async () => {
    const ctx = createTestContext();
    expect((await request(ctx.app).get('/api/brands')).status).toBe(401);
  });
});

describe('GET /api/brands/:id', () => {
  it('操作人員讀取其他品牌回傳 404（不洩漏是否存在）', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('opA');
    const own = await agent.get(`/api/brands/${ctx.fx.brandA}`);
    expect(own.status).toBe(200);
    expect(own.body.name).toBe('品牌甲');
    expect(own.body).not.toHaveProperty('accountCount');
    const other = await agent.get(`/api/brands/${ctx.fx.brandB}`);
    expect(other.status).toBe(404);
    expect(other.body.error.message).toBe('找不到品牌');
    expect((await agent.get('/api/brands/99999')).status).toBe(404);
    expect((await agent.get('/api/brands/abc')).status).toBe(404);
  });

  it('品牌停用後主管讀取回傳 404；管理員仍可讀取並看到統計', async () => {
    const ctx = createTestContext();
    run(ctx.db, 'UPDATE brands SET is_active = 0 WHERE id = ?', [ctx.fx.brandA]);
    const sup = await ctx.loginAs('sup');
    expect((await sup.get(`/api/brands/${ctx.fx.brandA}`)).status).toBe(404);
    const admin = await ctx.loginAs('admin');
    const res = await admin.get(`/api/brands/${ctx.fx.brandA}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isActive: false, accountCount: 1 });
  });
});

describe('POST /api/brands', () => {
  it('管理員可新增品牌：代碼轉大寫、建立預設設定並寫入操作紀錄', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/brands').send({ ...validInput, name: '  新品牌  ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: '新品牌', code: 'NEW-1', color: '#aabbcc', description: '測試用品牌', nearDueMinutes: 20, isActive: true,
      accountCount: 0, userCount: 0, commentCount: 0,
    });
    const id = res.body.id as number;

    const settings = get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM brand_category_settings WHERE brand_id = ?', [id])!;
    expect(settings.n).toBe(DEFAULT_CATEGORIES.length);
    expect(settings.n).toBe(16);
    const style = get<{ updated_by_id: number }>(ctx.db, 'SELECT updated_by_id FROM brand_styles WHERE brand_id = ?', [id]);
    expect(style?.updated_by_id).toBe(ctx.fx.admin);

    const logs = auditRows(ctx, 'brand.create');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor_user_id: ctx.fx.admin, brand_id: id });
    expect(logs[0].summary).toContain('新品牌');
    expect(JSON.parse(logs[0].after!)).toMatchObject({ code: 'NEW-1', nearDueMinutes: 20 });
  });

  it('說明與即將超時門檻有預設值', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/brands').send({ name: '預設品牌', code: 'DEF', color: '#123abc' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ description: '', nearDueMinutes: 15 });
  });

  it.each([
    ['代表色格式錯誤', { color: 'red' }, 'color'],
    ['代表色少一碼', { color: '#12345' }, 'color'],
    ['代碼含中文', { code: '品牌' }, 'code'],
    ['代碼太短', { code: 'A' }, 'code'],
    ['代碼太長', { code: 'ABCDEFGHIJKLM' }, 'code'],
    ['代碼含空白', { code: 'A B' }, 'code'],
    ['名稱空白', { name: '   ' }, 'name'],
    ['名稱過長', { name: '名'.repeat(41) }, 'name'],
    ['說明過長', { description: '字'.repeat(201) }, 'description'],
    ['門檻為 0', { nearDueMinutes: 0 }, 'nearDueMinutes'],
    ['門檻超過 240', { nearDueMinutes: 241 }, 'nearDueMinutes'],
    ['門檻非整數', { nearDueMinutes: 1.5 }, 'nearDueMinutes'],
    ['門檻為文字', { nearDueMinutes: '15' }, 'nearDueMinutes'],
  ])('輸入驗證：%s → 400', async (_label, override, field) => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/brands').send({ ...validInput, ...override });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe(field);
    expect(res.body.error.message).toMatch(/[一-鿿]/);
    expect(get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM brands')!.n).toBe(2);
    expect(auditRows(ctx)).toHaveLength(0);
  });

  it('缺少必填欄位 → 400', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/brands').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('品牌名稱');
  });

  it('名稱重複 → 409「品牌名稱已存在」', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/brands').send({ ...validInput, name: '品牌甲' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('品牌名稱已存在');
    expect(res.body.error.details.field).toBe('name');
  });

  it('代碼重複（不分大小寫）→ 409「品牌代碼已存在」', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.post('/api/brands').send({ ...validInput, code: 'ba' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('品牌代碼已存在');
    expect(res.body.error.details.field).toBe('code');
    expect(auditRows(ctx)).toHaveLength(0);
  });

  it('主管與操作人員不可新增品牌（403）', async () => {
    const ctx = createTestContext();
    for (const who of ['sup', 'opA'] as const) {
      const agent = await ctx.loginAs(who);
      const res = await agent.post('/api/brands').send(validInput);
      expect(res.status).toBe(403);
    }
    expect(get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM brands')!.n).toBe(2);
  });
});

describe('PATCH /api/brands/:id', () => {
  it('修改欄位並寫入 brand.update（只記錄有變動的欄位）', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent
      .patch(`/api/brands/${ctx.fx.brandA}`)
      .send({ name: '品牌甲（新）', color: '#123456', description: '新的說明', nearDueMinutes: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: '品牌甲（新）', description: '新的說明', nearDueMinutes: 30, accountCount: 1, userCount: 2 });

    const logs = auditRows(ctx);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('brand.update');
    expect(logs[0].brand_id).toBe(ctx.fx.brandA);
    expect(logs[0].summary).toContain('品牌甲');
    // color 沒變（#123456），不應出現在紀錄中
    expect(JSON.parse(logs[0].before!)).toEqual({ name: '品牌甲', description: '', nearDueMinutes: 15 });
    expect(JSON.parse(logs[0].after!)).toEqual({ name: '品牌甲（新）', description: '新的說明', nearDueMinutes: 30 });
  });

  it('沒有任何變動時回 200 且不寫操作紀錄', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const before = get<{ updated_at: string }>(ctx.db, 'SELECT updated_at FROM brands WHERE id = ?', [ctx.fx.brandA])!;
    const res = await agent
      .patch(`/api/brands/${ctx.fx.brandA}`)
      .send({ name: '品牌甲', color: '#123456', description: '', nearDueMinutes: 15, isActive: true, code: 'ba' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('品牌甲');
    expect(auditRows(ctx)).toHaveLength(0);
    const after = get<{ updated_at: string }>(ctx.db, 'SELECT updated_at FROM brands WHERE id = ?', [ctx.fx.brandA])!;
    expect(after.updated_at).toBe(before.updated_at);
  });

  it('品牌代碼建立後不可修改（400）', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.patch(`/api/brands/${ctx.fx.brandA}`).send({ code: 'NEWCODE', name: '改名' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('品牌代碼建立後不可修改');
    const row = get<{ code: string; name: string }>(ctx.db, 'SELECT code, name FROM brands WHERE id = ?', [ctx.fx.brandA])!;
    expect(row).toEqual({ code: 'BA', name: '品牌甲' });
    expect(auditRows(ctx)).toHaveLength(0);
  });

  it('改成已存在的名稱 → 409', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.patch(`/api/brands/${ctx.fx.brandA}`).send({ name: '品牌乙' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('品牌名稱已存在');
  });

  it('輸入驗證錯誤 → 400', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    expect((await agent.patch(`/api/brands/${ctx.fx.brandA}`).send({ color: 'blue' })).status).toBe(400);
    expect((await agent.patch(`/api/brands/${ctx.fx.brandA}`).send({ nearDueMinutes: 500 })).status).toBe(400);
    expect((await agent.patch(`/api/brands/${ctx.fx.brandA}`).send({ isActive: 'no' })).status).toBe(400);
    expect(auditRows(ctx)).toHaveLength(0);
  });

  it('不存在的品牌 → 404', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    expect((await agent.patch('/api/brands/99999').send({ name: '不存在' })).status).toBe(404);
  });

  it('主管與操作人員不可修改品牌（403）', async () => {
    const ctx = createTestContext();
    for (const who of ['sup', 'opA'] as const) {
      const agent = await ctx.loginAs(who);
      expect((await agent.patch(`/api/brands/${ctx.fx.brandA}`).send({ name: '偷改' })).status).toBe(403);
      expect((await agent.patch(`/api/brands/${ctx.fx.brandA}`).send({ isActive: false })).status).toBe(403);
    }
    const row = get<{ name: string; is_active: number }>(ctx.db, 'SELECT name, is_active FROM brands WHERE id = ?', [ctx.fx.brandA])!;
    expect(row).toEqual({ name: '品牌甲', is_active: 1 });
  });

  it('停用後品牌從操作人員的可存取品牌中消失；重新啟用後恢復，並寫入操作紀錄', async () => {
    const ctx = createTestContext();
    const admin = await ctx.loginAs('admin');
    const op = await ctx.loginAs('opA');
    expect((await op.get('/api/auth/me')).body.brands.map((b: { id: number }) => b.id)).toEqual([ctx.fx.brandA]);

    const off = await admin.patch(`/api/brands/${ctx.fx.brandA}`).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);

    expect((await op.get('/api/auth/me')).body.brands).toEqual([]);
    expect((await op.get('/api/brands')).body).toEqual([]);
    expect((await op.get(`/api/brands/${ctx.fx.brandA}`)).status).toBe(404);
    // 管理員仍看得到（含停用）
    const adminList = (await admin.get('/api/brands')).body as Brand[];
    expect(adminList.find((b) => b.id === ctx.fx.brandA)?.isActive).toBe(false);
    // 資料保留
    expect(get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM comments WHERE brand_id = ?', [ctx.fx.brandA])!.n).toBe(1);

    const on = await admin.patch(`/api/brands/${ctx.fx.brandA}`).send({ isActive: true });
    expect(on.status).toBe(200);
    expect((await op.get('/api/auth/me')).body.brands.map((b: { id: number }) => b.id)).toEqual([ctx.fx.brandA]);

    const logs = auditRows(ctx);
    expect(logs.map((l) => l.action)).toEqual(['brand.deactivate', 'brand.activate']);
    expect(logs[0].summary).toContain('停用品牌「品牌甲」');
    expect(JSON.parse(logs[0].before!)).toEqual({ isActive: true });
    expect(JSON.parse(logs[0].after!)).toEqual({ isActive: false });
    expect(logs[1].summary).toContain('啟用品牌「品牌甲」');
    expect(logs.every((l) => l.actor_user_id === ctx.fx.admin && l.brand_id === ctx.fx.brandA)).toBe(true);
  });

  it('同時修改欄位與停用時，分別寫入 brand.update 與 brand.deactivate', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const res = await agent.patch(`/api/brands/${ctx.fx.brandB}`).send({ description: '暫停經營', isActive: false });
    expect(res.status).toBe(200);
    expect(auditRows(ctx).map((l) => l.action)).toEqual(['brand.update', 'brand.deactivate']);
  });
});
