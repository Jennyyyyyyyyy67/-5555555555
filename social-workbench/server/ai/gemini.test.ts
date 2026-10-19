import { createTestContext } from '../test/helpers';
import { get, insert } from '../db';
import { nowIso } from '../lib/clock';
import { setGeminiFetch } from './gemini';

/** 假的 Gemini：第一次（帶 JSON Schema）可設定回 400，測試改用提示詞要求格式的備援 */
function fakeGemini(opts: { rejectSchema?: boolean; status?: number } = {}) {
  const calls: Array<{ url: string; body: Record<string, any> }> = [];
  setGeminiFetch(async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    calls.push({ url: String(input), body });
    if (opts.status) return new Response(JSON.stringify({ error: { message: 'Resource exhausted' } }), { status: opts.status });
    if (opts.rejectSchema && body.generationConfig.responseJsonSchema) {
      return new Response(JSON.stringify({ error: { message: 'Unknown name "responseJsonSchema"' } }), { status: 400 });
    }
    const system: string = body.systemInstruction.parts[0].text;
    const keys = ['friendly', 'concise', 'lively', 'professional'].filter((k) => system.includes(`  - ${k}：`));
    const text = JSON.stringify({ variants: keys.map((key) => ({ key, body: `謝謝您喜歡我們的咖啡！（${key}）`, knowledgeIds: [] })) });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: `\`\`\`json\n${text}\n\`\`\`` }] }, finishReason: 'STOP' }], modelVersion: 'gemini-test' }), { status: 200 });
  });
  return calls;
}

async function praiseComment(ctx: Awaited<ReturnType<typeof createTestContext>>) {
  const now = nowIso();
  const cat = (await get<{ id: number }>(ctx.db, "SELECT id FROM comment_categories WHERE key = 'praise'"))!;
  return insert(ctx.db, 'comments', {
    brand_id: ctx.fx.brandA, social_account_id: ctx.fx.accountA, post_id: ctx.fx.postA, external_id: `g-${Math.random()}`,
    author_name: '小魚', body: '咖啡超好喝！', category_id: cat.id, occurred_at: now, fetched_at: now, created_at: now, updated_at: now,
  });
}

describe('免費 AI（Gemini）', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'gem-key';
  });
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    setGeminiFetch(null);
  });

  it('沒有 Claude、有 Gemini 時用 Gemini 產生回覆建議；分類仍用關鍵字規則', async () => {
    const ctx = await createTestContext();
    const calls = fakeGemini();
    const admin = await ctx.loginAs('admin');
    expect((await admin.get('/api/meta')).body.ai).toEqual({ provider: 'gemini', model: 'gemini-flash-latest' });
    const id = await praiseComment(ctx);
    const res = await admin.post(`/api/comments/${id}/suggestions`);
    expect(res.body.latest.variants[0].body).toContain('謝謝您喜歡我們的咖啡！');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('models/gemini-flash-latest:generateContent');
    expect(calls[0].body.contents[0].parts[0].text).toContain('<comment>\n咖啡超好喝！\n</comment>');

    // 新留言分類不呼叫 Gemini（節省免費額度）
    await admin.post('/api/automation/test').send({ brandId: ctx.fx.brandA, platform: 'facebook', body: '請問營業時間' });
    expect(calls).toHaveLength(1);
  });

  it('不支援 JSON Schema 時改用提示詞要求格式；額度用完時改用範本，不會出錯', async () => {
    const ctx = await createTestContext();
    const calls = fakeGemini({ rejectSchema: true });
    const admin = await ctx.loginAs('admin');
    const id = await praiseComment(ctx);
    const ok = await admin.post(`/api/comments/${id}/suggestions`);
    expect(ok.body.latest.variants[0].body).toContain('謝謝您喜歡我們的咖啡！');
    expect(calls).toHaveLength(2);
    expect(calls[1].body.systemInstruction.parts[0].text).toContain('JSON Schema');

    fakeGemini({ status: 429 });
    const fallback = await admin.post(`/api/comments/${id}/suggestions`);
    expect(fallback.status).toBe(201);
    expect(fallback.body.latest.variants.length).toBeGreaterThan(0);
    expect(fallback.body.latest.variants[0].body).not.toContain('謝謝您喜歡我們的咖啡！');
  });
});
