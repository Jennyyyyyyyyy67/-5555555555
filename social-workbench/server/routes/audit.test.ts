import request from 'supertest';
import { createTestContext } from '../test/helpers';
import { audit } from '../services/audit';
import type { AuditLogEntry } from '../../shared/types';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

/** 建立幾筆不同品牌、不同執行者的操作紀錄（時間早於登入紀錄） */
async function seedLogs(ctx: Ctx) {
  const { fx, db } = ctx;
  return {
    brandAByAdmin: await audit(db, {
      actorType: 'user', actorUserId: fx.admin, brandId: fx.brandA, action: 'brand.update', targetType: 'brand', targetId: fx.brandA,
      summary: '修改品牌「品牌甲」', before: { color: '#000000' }, after: { color: '#123456' }, createdAt: '2026-01-01T01:00:00.000Z',
    }),
    brandBByAdmin: await audit(db, {
      actorType: 'user', actorUserId: fx.admin, brandId: fx.brandB, action: 'brand.update', targetType: 'brand', targetId: fx.brandB,
      summary: '修改品牌「品牌乙」', createdAt: '2026-01-01T02:00:00.000Z',
    }),
    brandBByOpB: await audit(db, {
      actorType: 'user', actorUserId: fx.opB, brandId: fx.brandB, action: 'comment.reply', summary: '乙操作回覆留言',
      createdAt: '2026-01-01T03:00:00.000Z',
    }),
    systemNoBrand: await audit(db, {
      actorType: 'system', action: 'mock.reset', summary: '重設示範資料', detail: { brands: 2 }, createdAt: '2026-01-01T04:00:00.000Z',
    }),
    supNoBrand: await audit(db, {
      actorType: 'user', actorUserId: fx.sup, action: 'user.update_self', summary: '主管修改個人資料', createdAt: '2026-01-01T05:00:00.000Z',
    }),
    brandAByAi: await audit(db, {
      actorType: 'ai', brandId: fx.brandA, action: 'comment.analyze', summary: 'AI 判斷留言類型', createdAt: '2026-01-01T06:00:00.000Z',
    }),
  };
}

const isSortedDesc = (list: AuditLogEntry[]) =>
  list.every((e, i) => i === 0 || e.createdAt < list[i - 1].createdAt || (e.createdAt === list[i - 1].createdAt && e.id < list[i - 1].id));

describe('GET /api/audit/recent', () => {
  it('操作人員回傳 403；未登入回傳 401', async () => {
    const ctx = await createTestContext();
    const agent = await ctx.loginAs('opA');
    expect((await agent.get('/api/audit/recent')).status).toBe(403);
    expect((await request(ctx.app).get('/api/audit/recent')).status).toBe(401);
  });

  it('管理員看到全部紀錄，由新到舊，並帶出執行者與品牌名稱', async () => {
    const ctx = await createTestContext();
    const ids = await seedLogs(ctx);
    const agent = await ctx.loginAs('admin');
    const res = await agent.get('/api/audit/recent').query({ limit: 100 });
    expect(res.status).toBe(200);
    const list = res.body as AuditLogEntry[];
    const seededIds = Object.values(ids);
    expect(seededIds.every((id) => list.some((e) => e.id === id))).toBe(true);
    expect(isSortedDesc(list)).toBe(true);
    // 種下的紀錄依時間由新到舊
    expect(list.filter((e) => seededIds.includes(e.id)).map((e) => e.id)).toEqual([...seededIds].reverse());

    const updated = list.find((e) => e.id === ids.brandAByAdmin)!;
    expect(updated).toMatchObject({
      brandId: ctx.fx.brandA,
      brandName: '品牌甲',
      actorType: 'user',
      actorUserId: ctx.fx.admin,
      actorName: '管理員',
      action: 'brand.update',
      targetType: 'brand',
      targetId: ctx.fx.brandA,
      summary: '修改品牌「品牌甲」',
      before: { color: '#000000' },
      after: { color: '#123456' },
      detail: null,
    });
    const system = list.find((e) => e.id === ids.systemNoBrand)!;
    expect(system).toMatchObject({ actorType: 'system', actorName: null, brandName: null, detail: { brands: 2 } });
  });

  it('主管只看到負責品牌的紀錄與自己的操作', async () => {
    const ctx = await createTestContext();
    const ids = await seedLogs(ctx);
    await ctx.loginAs('opB'); // 其他人的登入紀錄（無品牌）不應出現
    const agent = await ctx.loginAs('sup');
    const res = await agent.get('/api/audit/recent').query({ limit: 100 });
    expect(res.status).toBe(200);
    const list = res.body as AuditLogEntry[];
    const visible = new Set(list.map((e) => e.id));
    expect(visible.has(ids.brandAByAdmin)).toBe(true);
    expect(visible.has(ids.brandAByAi)).toBe(true);
    expect(visible.has(ids.supNoBrand)).toBe(true);
    expect(visible.has(ids.brandBByAdmin)).toBe(false);
    expect(visible.has(ids.brandBByOpB)).toBe(false);
    expect(visible.has(ids.systemNoBrand)).toBe(false);
    for (const e of list) expect(e.brandId === ctx.fx.brandA || e.actorUserId === ctx.fx.sup).toBe(true);
    // 自己的登入紀錄會出現，乙操作的登入紀錄不會
    expect(list.some((e) => e.action === 'auth.login' && e.actorUserId === ctx.fx.sup)).toBe(true);
    expect(list.some((e) => e.actorUserId === ctx.fx.opB)).toBe(false);
    expect(isSortedDesc(list)).toBe(true);
  });

  it('limit 預設 20、最多 100；格式不正確回傳 400', async () => {
    const ctx = await createTestContext();
    for (let i = 0; i < 105; i++) {
      await audit(ctx.db, { actorType: 'system', action: 'test.bulk', summary: `測試 ${i}`, createdAt: '2026-01-01T00:00:00.000Z' });
    }
    const agent = await ctx.loginAs('admin');
    expect((await agent.get('/api/audit/recent')).body).toHaveLength(20);
    expect((await agent.get('/api/audit/recent').query({ limit: 3 })).body).toHaveLength(3);
    const many = await agent.get('/api/audit/recent').query({ limit: 500 });
    expect(many.status).toBe(200);
    expect(many.body).toHaveLength(100);
    expect((await agent.get('/api/audit/recent').query({ limit: 0 })).status).toBe(400);
    expect((await agent.get('/api/audit/recent').query({ limit: 'x' })).status).toBe(400);
  });
});
