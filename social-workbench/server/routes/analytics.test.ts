import { createTestContext } from '../test/helpers';
import { all, get } from '../db';
import { setClock, nowIso } from '../lib/clock';
import { buildInsights, detectAnomalies, localDate, opsMetrics, parseRange, previousRange, type CRow } from '../services/analytics';

let seq = 1;
function row(extra: Partial<CRow> = {}): CRow {
  return {
    id: seq++, brand_id: 1, brand_name: '品牌甲', brand_color: '#000', post_id: 1, post_title: '新品上市', is_ad: 0, platform: 'facebook',
    parent_comment_id: null, thread_root_id: null, author_name: '顧客', body: '好喜歡', occurred_at: '2026-03-10T10:00:00.000Z',
    status: 'pending', sla_due_at: null, sla_minutes: null, first_response_at: null, first_response_type: null, first_response_by_id: null,
    is_auto_handled: 0, needs_human: 0, knowledge_gap: 0, sentiment: 'neutral', rating: null, tags: '[]', category_key: 'general',
    category_name: '一般互動', handled_by_id: null, completed_at: null, visibility: 'visible', ...extra,
  };
}
const REF = '2026-03-10T12:00:00.000Z';
const hoursAgo = (h: number) => new Date(Date.parse(REF) - h * 3600_000).toISOString();

describe('日期範圍', () => {
  it('預設最近 7 天（台灣時間），前一期等長', () => {
    setClock(() => new Date('2026-03-10T17:00:00.000Z')); // 台灣 3/11 凌晨
    try {
      expect(parseRange(undefined, undefined)).toEqual({ from: '2026-03-05', to: '2026-03-11' });
    } finally {
      setClock(null);
    }
    expect(previousRange({ from: '2026-03-05', to: '2026-03-11' })).toEqual({ from: '2026-02-26', to: '2026-03-04' });
    expect(() => parseRange('2026-03-10', '2026-03-01')).toThrow();
    expect(() => parseRange('3/1', '2026-03-01')).toThrow();
    expect(localDate('2026-03-10T16:30:00.000Z')).toBe('2026-03-11');
  });
});

describe('營運指標', () => {
  it('時效達成率只計算已回覆或已超時的留言；60 分鐘內回覆率', () => {
    const now = '2026-03-10T12:00:00.000Z';
    const m = opsMetrics(
      [
        row({ occurred_at: '2026-03-10T10:00:00.000Z', sla_due_at: '2026-03-10T10:30:00.000Z', first_response_at: '2026-03-10T10:20:00.000Z', status: 'done' }),
        row({ occurred_at: '2026-03-10T10:00:00.000Z', sla_due_at: '2026-03-10T10:30:00.000Z', first_response_at: '2026-03-10T10:50:00.000Z', status: 'waiting' }),
        row({ occurred_at: '2026-03-10T09:00:00.000Z', sla_due_at: '2026-03-10T10:00:00.000Z' }), // 超時未回
        row({ occurred_at: '2026-03-10T11:50:00.000Z', sla_due_at: '2026-03-10T12:50:00.000Z' }), // 還在時限內，不列入
      ],
      [],
      0,
      now,
    );
    expect(m.slaMetRate).toBeCloseTo(1 / 3);
    expect(m.within60Rate).toBeCloseTo(2 / 3);
    expect(m.avgFirstResponseMinutes).toBe(35);
    expect(m.pending).toBe(2);
  });
});

describe('異常事件偵測', () => {
  it('負面留言突然增加', () => {
    const rows = [
      ...[1, 2, 3, 4].map((h) => row({ sentiment: 'negative', occurred_at: hoursAgo(h), body: '很失望' })),
      row({ sentiment: 'negative', occurred_at: hoursAgo(72) }),
    ];
    const ev = detectAnomalies(rows, REF);
    expect(ev.find((e) => e.type === 'negative_spike')).toMatchObject({ current: 4 });
  });

  it('產品問題集中、貼文湧入、重複詢問、潛在商機、低星評論、熱烈討論', () => {
    const rows = [
      ...[1, 2, 3].map((h) => row({ category_key: 'after_sales', occurred_at: hoursAgo(h), tags: '["濾芯","漏水"]', body: '濾芯漏水' })),
      ...Array.from({ length: 8 }, (_, i) => row({ post_id: 9, post_title: '週年慶', occurred_at: hoursAgo(1), category_key: 'price_inquiry', body: i % 2 ? '多少錢' : '價格？' })),
      row({ category_key: 'bulk_purchase', occurred_at: hoursAgo(5), body: '公司想訂 200 組' }),
      ...[1, 2].map((d) => row({ platform: 'google', rating: 1, occurred_at: hoursAgo(d * 24), body: '服務很差', sentiment: 'negative' })),
      ...[1, 2, 3, 4].map(() => row({ thread_root_id: 500, parent_comment_id: 500, occurred_at: hoursAgo(2), body: '同意' })),
    ];
    const types = detectAnomalies(rows, REF).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['product_issue', 'post_burst', 'repeated_question', 'opportunity', 'low_rating', 'hot_thread']));
    const issue = detectAnomalies(rows, REF).find((e) => e.type === 'product_issue')!;
    expect(issue.title).toMatch(/濾芯|漏水/);
    expect(issue.examples.length).toBeGreaterThan(0);
  });

  it('平常就有的量不算異常', () => {
    const rows = Array.from({ length: 8 }, (_, d) => [1, 2, 3].map((h) => row({ sentiment: 'negative', occurred_at: hoursAgo(d * 24 + h) }))).flat();
    expect(detectAnomalies(rows, REF).find((e) => e.type === 'negative_spike')).toBeUndefined();
  });
});

describe('社群洞察', () => {
  it('整理熱門問題、購買阻力、需求與內容建議', () => {
    const rows = [
      row({ category_key: 'price_inquiry', body: '多少錢？', tags: '["禮盒"]' }),
      row({ category_key: 'price_inquiry', body: '價格？', tags: '["禮盒"]' }),
      row({ category_key: 'usage', body: '濾芯怎麼換', tags: '["濾芯"]' }),
      row({ category_key: 'general', body: '有點貴，運費也太高', tags: '[]' }),
      row({ category_key: 'general', body: '希望可以出大容量', tags: '["容量"]' }),
      row({ category_key: 'praise', body: '超好喝', sentiment: 'positive', tags: '["拿鐵"]' }),
    ];
    const s = Object.fromEntries(buildInsights(rows, (p) => p).map((x) => [x.key, x]));
    expect(s.hot_questions.items[0]).toMatchObject({ label: '詢問價格', count: 2 });
    expect(s.barriers.items.map((i) => i.label)).toEqual(expect.arrayContaining(['價格偏高', '運費']));
    expect(s.needs.items[0].label).toBe('容量');
    expect(s.positive.items[0].label).toBe('拿鐵');
    expect(s.content_ideas.items.some((i) => i.label.includes('濾芯'))).toBe(true);
  });
});

describe('數據看板 API', () => {
  async function simulate(ctx: Awaited<ReturnType<typeof createTestContext>>) {
    const admin = await ctx.loginAs('admin');
    await admin.post('/api/automation/rules').send({ brandId: ctx.fx.brandA, name: '稱讚', action: 'auto_reply', categories: ['praise'], platforms: [], minConfidence: 0.85, isActive: true });
    await admin.post('/api/automation/simulate').send({ postId: ctx.fx.postA, authorName: '小魚', body: '咖啡超好喝！回購了 👍' });
    const c = await admin.post('/api/automation/simulate').send({ postId: ctx.fx.postA, authorName: '阿德', body: '買不到一個月就漏水，到底要怎麼處理？' });
    return { admin, complaintId: c.body.commentId as number };
  }

  it('看板：營運、AI、社群、團隊數據', async () => {
    const ctx = await createTestContext();
    const { complaintId } = await simulate(ctx);
    const op = await ctx.loginAs('opA');
    await op.post(`/api/comments/${complaintId}/reply`).send({ body: '很抱歉，請私訊訂單編號', statusAfter: 'waiting' });
    const sup = await ctx.loginAs('sup');
    const res = await sup.get('/api/analytics/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.brandIds).toEqual([ctx.fx.brandA]);
    expect(res.body.ops.total).toBeGreaterThanOrEqual(2);
    expect(res.body.ai.autoReplied).toBe(1);
    expect(res.body.ai.humanReplies).toBe(1);
    expect(res.body.community.complaints).toBeGreaterThanOrEqual(1);
    expect(res.body.team.find((t: { userId: number }) => t.userId === ctx.fx.opA)).toMatchObject({ replies: 1, firstResponses: 1 });
    expect(res.body.daily).toHaveLength(7);
  });

  it('權限：操作人員不能看；主管不能看其他品牌', async () => {
    const ctx = await createTestContext();
    const op = await ctx.loginAs('opA');
    expect((await op.get('/api/analytics/dashboard')).status).toBe(403);
    const sup = await ctx.loginAs('sup');
    expect((await sup.get(`/api/analytics/dashboard?brand=${ctx.fx.brandB}`)).status).toBe(403);
    expect((await sup.get('/api/analytics/dashboard?from=2026-13-01')).status).toBe(400);
  });

  it('報表：與前一期比較、品牌與平台比較、重點摘要、洞察', async () => {
    const ctx = await createTestContext();
    const { admin } = await simulate(ctx);
    const res = await admin.get('/api/analytics/report');
    expect(res.status).toBe(200);
    expect(res.body.previous.to < res.body.range.from).toBe(true);
    expect(res.body.brands.length).toBeGreaterThan(0);
    expect(res.body.platforms[0].label).toBe('Facebook');
    expect(res.body.highlights[0]).toMatch(/共收到/);
    expect(res.body.insights.length).toBe(10);
  });

  it('異常事件可標記已處理，並留下紀錄', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    for (const b of ['很失望', '品質很差', '超爛的，再也不買', '太扯了吧，很失望']) {
      await admin.post('/api/automation/simulate').send({ postId: ctx.fx.postA, authorName: '顧客', body: b });
    }
    const list = await admin.get(`/api/analytics/anomalies?brand=${ctx.fx.brandA}`);
    const ev = list.body.events.find((e: { type: string }) => e.type === 'negative_spike');
    expect(ev).toBeTruthy();
    expect((await admin.post('/api/analytics/anomalies/ack').send({ key: ev.key, brandId: ctx.fx.brandB, title: ev.title, type: ev.type })).status).toBe(400);
    expect((await admin.post('/api/analytics/anomalies/ack').send({ key: ev.key, brandId: ev.brandId, title: ev.title, type: ev.type, note: '已通知品管' })).status).toBe(204);
    const again = await admin.get(`/api/analytics/anomalies?brand=${ctx.fx.brandA}`);
    expect(again.body.events.find((e: { key: string }) => e.key === ev.key).ack).toMatchObject({ note: '已通知品管' });
    expect(await get(ctx.db, "SELECT id FROM audit_logs WHERE action = 'anomaly.resolve'")).toBeTruthy();
  });

  it('洞察 API 預設 30 天', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    const res = await admin.get('/api/analytics/insights');
    expect(res.status).toBe(200);
    expect(res.body.sections.map((s: { key: string }) => s.key)).toContain('content_ideas');
    expect(localDate(nowIso())).toBe(res.body.range.to);
  });
});

describe('操作紀錄查詢', () => {
  it('依類別、留言、關鍵字篩選並分頁；回覆紀錄附上 AI 原始建議', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    await admin.post('/api/automation/rules').send({ brandId: ctx.fx.brandA, name: '稱讚', action: 'auto_reply', categories: ['praise'], platforms: [], minConfidence: 0.85, isActive: true });
    const sim = await admin.post('/api/automation/simulate').send({ postId: ctx.fx.postA, authorName: '小魚', body: '好喝！' });
    const replies = await admin.get('/api/audit?group=reply');
    expect(replies.status).toBe(200);
    const auto = replies.body.items.find((i: { action: string }) => i.action === 'comment.auto_reply');
    expect(auto.actorType).toBe('rule');
    expect(auto.replyBody).toBeTruthy();
    const byComment = await admin.get(`/api/audit?commentId=${sim.body.commentId}`);
    expect(byComment.body.items.every((i: { commentId: number }) => i.commentId === sim.body.commentId)).toBe(true);
    expect((await admin.get('/api/audit?q=自動化規則')).body.total).toBeGreaterThan(0);
    const paged = await admin.get('/api/audit?pageSize=1&page=2');
    expect(paged.body.items).toHaveLength(1);
    expect((await admin.get('/api/audit?group=nope')).status).toBe(400);
  });

  it('主管只看得到負責品牌；操作人員不能查', async () => {
    const ctx = await createTestContext();
    const admin = await ctx.loginAs('admin');
    await admin.post('/api/automation/simulate').send({ postId: ctx.fx.postB, authorName: 'x', body: '好喝' });
    const sup = await ctx.loginAs('sup');
    const res = await sup.get('/api/audit');
    expect(res.body.items.every((i: { brandId: number | null }) => i.brandId !== ctx.fx.brandB)).toBe(true);
    expect((await sup.get(`/api/audit?brand=${ctx.fx.brandB}`)).status).toBe(403);
    const op = await ctx.loginAs('opA');
    expect((await op.get('/api/audit')).status).toBe(403);
    const n = await all(ctx.db, 'SELECT id FROM audit_logs');
    expect(n.length).toBeGreaterThan(0);
  });
});
