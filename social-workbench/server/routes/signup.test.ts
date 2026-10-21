import request from 'supertest';
import { createTestContext } from '../test/helpers';
import { get } from '../db';

const input = { companyName: '舞蹈教室', name: '小甄', email: 'owner@dance.tw', password: 'password123' };

describe('企業自助註冊', () => {

  it('建立企業負責人與專屬品牌，註冊後直接登入', async () => {
    const ctx = await createTestContext();
    const agent = request.agent(ctx.app);
    const res = await agent.post('/api/auth/signup').send(input);
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('owner');
    expect(res.body.brands.map((b: { name: string }) => b.name)).toEqual(['舞蹈教室']);
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.email).toBe('owner@dance.tw');
    const style = await get<{ signature: string }>(ctx.db, 'SELECT signature FROM brand_styles WHERE brand_id = ?', [res.body.brandId]);
    expect(style?.signature).toBe('舞蹈教室');
    // 可以用新帳號登入
    const login = await request(ctx.app).post('/api/auth/login').send({ email: input.email, password: input.password });
    expect(login.status).toBe(200);
  });

  it('只看得到自己的品牌與留言，不能改系統共用設定', async () => {
    const ctx = await createTestContext();
    const agent = request.agent(ctx.app);
    const brandId = (await agent.post('/api/auth/signup').send(input)).body.brandId;
    expect((await agent.get('/api/comments')).body.items).toHaveLength(0);
    expect((await agent.get(`/api/comments/${ctx.fx.commentA}`)).status).toBe(404);
    expect((await agent.get('/api/brands')).body.map((b: { id: number }) => b.id)).toEqual([brandId]);
    // 自己品牌的設定可以改
    const rule = await agent.post('/api/automation/rules').send({
      brandId, name: '價格', action: 'auto_reply', matchType: 'keyword', keywords: ['價格'], replyTemplate: '已私訊你', categories: [], platforms: [], minConfidence: 0.85, isActive: true,
    });
    expect(rule.status).toBe(201);
    const otherRule = await agent.post('/api/automation/rules').send({
      brandId: ctx.fx.brandA, name: 'x', action: 'auto_reply', matchType: 'keyword', keywords: ['a'], replyTemplate: 'b', categories: [], platforms: [], minConfidence: 0.85, isActive: true,
    });
    expect(otherRule.status).toBe(404);
    // 共用的留言類型、品牌管理、人員管理、模擬資料都不行
    expect((await agent.post('/api/categories').send({ name: '新類型', defaultSlaMinutes: 30, defaultPriority: 'low', needsReply: true })).status).toBe(403);
    expect((await agent.post('/api/brands').send({ name: 'x', code: 'XX', color: '#123456' })).status).toBe(403);
    expect((await agent.post('/api/mock/reset').send({ confirm: true })).status).toBe(403);
    expect((await agent.post('/api/users').send({ name: 'x', email: 'x@x.tw', role: 'admin', brandIds: [] })).status).toBe(403);
  });

  it('Email 或品牌名稱重複會提示；關閉註冊時拒絕', async () => {
    const ctx = await createTestContext();
    expect((await request(ctx.app).post('/api/auth/signup').send(input)).status).toBe(201);
    const dupEmail = await request(ctx.app).post('/api/auth/signup').send({ ...input, companyName: '另一家' });
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.error.details.field).toBe('email');
    const dupName = await request(ctx.app).post('/api/auth/signup').send({ ...input, email: 'b@dance.tw', companyName: '品牌甲' });
    expect(dupName.status).toBe(409);
    expect(dupName.body.error.details.field).toBe('companyName');
    const short = await request(ctx.app).post('/api/auth/signup').send({ ...input, email: 'c@dance.tw', companyName: 'C', password: '123' });
    expect(short.status).toBe(400);
  });
});
