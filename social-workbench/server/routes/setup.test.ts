import { createTestContext } from '../test/helpers';
import { all, get } from '../db';
import { setClaudeCaller } from '../ai/claude';

const profile = {
  businessName: '小美髮廊',
  industry: '美髮店',
  description: '專做韓系染燙，一對一服務。',
  services: '剪髮、染髮、韓式燙髮、護髮',
  brandImage: '溫暖、細心、像朋友一樣的設計師',
  audience: '',
  addressing: '您',
  emojiUsage: 'light',
  signature: '小美髮廊',
  address: '台北市中山區南京東路 100 號',
  hours: '週二至週日 11:00-20:00，週一公休',
  booking: '採預約制，請私訊粉專或 LINE 預約。',
  contact: '',
  prices: '剪髮 600 元起，染髮 2000 元起',
  otherFacts: '附近有付費停車場',
  forbiddenPromises: '保證不傷髮\n免費重做',
};

describe('AI 快速設定', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    setClaudeCaller(null);
  });

  it('沒有 AI 時用範本產生草稿；知識庫內容原樣保留店家填的事實', async () => {
    const ctx = await createTestContext();
    const owner = await ctx.loginAs('admin');
    const res = await owner.post(`/api/brands/${ctx.fx.brandA}/setup/draft`).send(profile);
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('mock');
    expect(res.body.style).toMatchObject({ addressing: '您', emojiUsage: 'light', signature: '小美髮廊', forbiddenPromises: ['保證不傷髮', '免費重做'] });
    const titles = res.body.knowledge.map((k: { title: string }) => k.title);
    expect(titles).toEqual(['小美髮廊介紹', '服務項目', '店家地址', '營業時間', '預約方式', '價格資訊', '其他資訊']);
    const hours = res.body.knowledge.find((k: { title: string }) => k.title === '營業時間');
    expect(hours.content).toBe('營業時間：週二至週日 11:00-20:00，週一公休');
    expect(hours.keywords).toEqual(expect.arrayContaining(['週一', '星期一', '禮拜一']));
    expect(res.body.knowledge.find((k: { title: string }) => k.title === '價格資訊').content).toBe('剪髮 600 元起，染髮 2000 元起');
    expect(res.body.canned.length).toBeGreaterThanOrEqual(4);
    expect(res.body.toneNotes.find((t: { categoryName: string }) => t.categoryName === '客訴').note).toContain('致歉');

    // 操作人員不能使用
    const op = await ctx.loginAs('opA');
    expect((await op.post(`/api/brands/${ctx.fx.brandA}/setup/draft`).send(profile)).status).toBe(403);
  });

  it('AI 產生的回覆若出現店家沒提供的數字會標示提醒；留言類型不存在的會略過', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    setClaudeCaller(async (req) => {
      expect(req.user).toContain('<profile>');
      return {
        model: 'test',
        data: {
          style: { personality: '溫暖細心', speakingStyle: '像朋友', tone: '親切', formality: 9, humor: 2, replyLength: 'medium', commonPhrases: ['期待見到您'], bannedWords: ['一定'], unsuitableTones: ['冷淡'] },
          toneNotes: [{ categoryKey: 'complaint', note: '先致歉再引導私訊' }, { categoryKey: 'not_exist', note: 'x' }],
          canned: [
            { categoryKey: 'price_inquiry', title: '詢價', body: '{name} 您好，剪髮 600 元起喔！' },
            { categoryKey: 'price_inquiry', title: '燙髮價格', body: '{name} 您好，燙髮 3500 元喔！' },
          ],
          examples: [{ categoryKey: 'praise', scenario: '稱讚', sampleComment: '好喜歡', goodReply: '謝謝您！', badReply: '謝謝', notes: '' }],
          otherFactKeywords: ['停車', '停車場'],
        },
      };
    });
    const ctx = await createTestContext();
    const owner = await ctx.loginAs('admin');
    const res = await owner.post(`/api/brands/${ctx.fx.brandA}/setup/draft`).send(profile);
    expect(res.body.provider).toBe('claude');
    expect(res.body.style.formality).toBe(5);
    expect(res.body.style.bannedWords).toEqual(expect.arrayContaining(['一定', '保證', '絕對']));
    expect(res.body.toneNotes.find((t: { categoryName: string }) => t.categoryName === '客訴').note).toBe('先致歉再引導私訊');
    const [ok, invented] = res.body.canned;
    expect(ok.warnings).toEqual([]);
    expect(invented.warnings[0]).toContain('3500');
    expect(res.body.knowledge.find((k: { title: string }) => k.title === '其他資訊').keywords).toEqual(['停車', '停車場']);
  });

  it('確認後一次加入：風格、類型語氣、知識（直接生效）、標準回覆、範例；同名的略過', async () => {
    const ctx = await createTestContext();
    const owner = await ctx.loginAs('admin');
    const draft = (await owner.post(`/api/brands/${ctx.fx.brandA}/setup/draft`).send(profile)).body;
    const input = {
      style: draft.style,
      toneNotes: draft.toneNotes.map((t: { categoryId: number; note: string }) => ({ categoryId: t.categoryId, note: t.note })),
      knowledge: draft.knowledge.map(({ exists: _e, ...k }: { exists: boolean }) => k),
      canned: draft.canned.map((c: { categoryId: number | null; title: string; body: string }) => ({ categoryId: c.categoryId, title: c.title, body: c.body })),
      examples: draft.examples.map(({ categoryName: _n, warnings: _w, ...e }: { categoryName: string; warnings: string[] }) => e),
    };
    const res = await owner.post(`/api/brands/${ctx.fx.brandA}/setup/apply`).send(input);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ style: true, knowledge: 7, canned: draft.canned.length, examples: draft.examples.length });
    expect(res.body.toneNotes).toBeGreaterThan(5);

    const style = (await owner.get(`/api/brands/${ctx.fx.brandA}/style`)).body;
    expect(style.signature).toBe('小美髮廊');
    const k = await all<{ review_status: string }>(ctx.db, 'SELECT review_status FROM knowledge_items WHERE brand_id = ?', [ctx.fx.brandA]);
    expect(k.every((x) => x.review_status === 'approved')).toBe(true);
    // AI 建議會引用新的知識
    const search = await owner.post('/api/knowledge/search').send({ brandId: ctx.fx.brandA, body: '請問星期一有營業嗎？' });
    expect(search.body.hits.map((h: { title: string }) => h.title)).toContain('營業時間');

    // 再加入一次：同名的知識與標準回覆會略過
    const again = await owner.post(`/api/brands/${ctx.fx.brandA}/setup/apply`).send({ ...input, style: null, toneNotes: [], examples: [] });
    expect(again.body).toMatchObject({ knowledge: 0, canned: 0 });
    expect(again.body.skipped.length).toBe(7 + draft.canned.length);
    expect(await get(ctx.db, "SELECT id FROM audit_logs WHERE action = 'brand.quick_setup'")).toBeTruthy();
  });
});
