import request from 'supertest';
import { createTestContext } from '../test/helpers';
import { all } from '../db';

describe('登入與身分', () => {
  it('正確帳密可登入並取得可存取品牌', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('opA');
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('operator');
    expect(me.body.brands.map((b: { id: number }) => b.id)).toEqual([ctx.fx.brandA]);
  });

  it('管理員可存取全部品牌', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('admin');
    const me = await agent.get('/api/auth/me');
    expect(me.body.brands).toHaveLength(2);
  });

  it('錯誤密碼回傳 401 並留下操作紀錄', async () => {
    const ctx = createTestContext();
    const res = await request(ctx.app).post('/api/auth/login').send({ email: 'opa@test.tw', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toContain('錯誤');
    const logs = all<{ action: string }>(ctx.db, "SELECT action FROM audit_logs WHERE action = 'auth.login_failed'");
    expect(logs).toHaveLength(1);
  });

  it('連續失敗 5 次後暫時鎖定', async () => {
    const ctx = createTestContext();
    for (let i = 0; i < 5; i++) await request(ctx.app).post('/api/auth/login').send({ email: 'opb@test.tw', password: 'x' });
    const res = await request(ctx.app).post('/api/auth/login').send({ email: 'opb@test.tw', password: 'password123' });
    expect(res.status).toBe(429);
  });

  it('未登入呼叫受保護 API 回傳 401', async () => {
    const ctx = createTestContext();
    const res = await request(ctx.app).get('/api/meta');
    expect(res.status).toBe(401);
  });

  it('登出後 session 失效', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('sup');
    expect((await agent.post('/api/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('停用帳號的既有 session 立即失效', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('opB');
    ctx.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(ctx.fx.opB);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('操作紀錄不可修改或刪除', () => {
    const ctx = createTestContext();
    ctx.db.prepare("INSERT INTO audit_logs (actor_type, action, summary, created_at) VALUES ('system','x','x','2026-01-01')").run();
    expect(() => ctx.db.prepare("UPDATE audit_logs SET summary = 'y'").run()).toThrow();
    expect(() => ctx.db.prepare('DELETE FROM audit_logs').run()).toThrow();
  });

  it('資料庫層禁止未經人工確認的刪除／封鎖動作', () => {
    const ctx = createTestContext();
    const base = { comment_id: ctx.fx.commentA, brand_id: ctx.fx.brandA, created_at: '2026-01-01' };
    const stmt = ctx.db.prepare(
      'INSERT INTO comment_actions (comment_id, brand_id, action, confirmed_by_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    expect(() => stmt.run(base.comment_id, base.brand_id, 'delete', null, '洗版', base.created_at)).toThrow();
    expect(() => stmt.run(base.comment_id, base.brand_id, 'block', ctx.fx.opA, '', base.created_at)).toThrow();
    expect(() => stmt.run(base.comment_id, base.brand_id, 'delete', ctx.fx.opA, '洗版廣告', base.created_at)).not.toThrow();
  });
});

describe('系統中繼資料', () => {
  it('回傳 4 個平台與 16 個預設留言類型', async () => {
    const ctx = createTestContext();
    const agent = await ctx.loginAs('opA');
    const res = await agent.get('/api/meta');
    expect(res.status).toBe(200);
    expect(res.body.platforms.map((p: { key: string }) => p.key).sort()).toEqual(['facebook', 'google', 'instagram', 'youtube']);
    expect(res.body.categories).toHaveLength(16);
  });
});
