// 數據看板、異常事件、社群洞察與報表的計算。
// 留言量不大（單一品牌一天數百則），因此一次取出範圍內的資料在程式中彙總，讓看板與報表用同一套算法。
import type { DB } from '../db';
import { all, parseJson, sqlIn } from '../db';
import { badRequest } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { INTENTS } from '../ai/grouping';
import { DEFAULT_NEAR_DUE_MINUTES, type CommentStatus, type Role } from '../../shared/constants';
import type {
  AiMetrics,
  AnomalyEvent,
  AnomalyExample,
  AnomalyType,
  CommunityMetrics,
  ComparisonRow,
  CountItem,
  DailyPoint,
  DateRange,
  InsightExample,
  InsightItem,
  InsightSection,
  OpsMetrics,
  PostVolume,
  TeamMemberMetrics,
} from '../../shared/types';

const TZ_OFFSET_MS = 8 * 3600_000; // 台灣時間
const DAY = 86_400_000;
const MAX_RANGE_DAYS = 366;

/** ISO 時間 → 台灣日期 YYYY-MM-DD */
export function localDate(iso: string | number): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  return new Date(t + TZ_OFFSET_MS).toISOString().slice(0, 10);
}
/** 台灣日期當天 00:00 的時間戳 */
export function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}
const addDays = (date: string, n: number) => localDate(dayStart(date) + n * DAY + 3600_000);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 解析日期範圍；預設最近 7 天（含今天） */
export function parseRange(fromRaw: unknown, toRaw: unknown, defaultDays = 7): DateRange {
  const today = localDate(nowIso());
  const to = typeof toRaw === 'string' && toRaw ? toRaw : today;
  const from = typeof fromRaw === 'string' && fromRaw ? fromRaw : addDays(to, -(defaultDays - 1));
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || Number.isNaN(dayStart(from)) || Number.isNaN(dayStart(to))) throw badRequest('日期格式需為 YYYY-MM-DD');
  if (from > to) throw badRequest('開始日期不可晚於結束日期');
  if ((dayStart(to) - dayStart(from)) / DAY >= MAX_RANGE_DAYS) throw badRequest(`日期範圍最多 ${MAX_RANGE_DAYS} 天`);
  return { from, to };
}

/** 與指定範圍等長、緊接在前的範圍（報表比較用） */
export function previousRange(r: DateRange): DateRange {
  const days = Math.round((dayStart(r.to) - dayStart(r.from)) / DAY) + 1;
  return { from: addDays(r.from, -days), to: addDays(r.from, -1) };
}

function rangeIso(r: DateRange): { start: string; end: string } {
  return { start: new Date(dayStart(r.from)).toISOString(), end: new Date(dayStart(r.to) + DAY).toISOString() };
}

export function datesIn(r: DateRange): string[] {
  const out: string[] = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------- 資料載入 ----------
export interface CRow {
  id: number;
  brand_id: number;
  brand_name: string;
  brand_color: string;
  post_id: number;
  post_title: string;
  is_ad: number;
  platform: string;
  parent_comment_id: number | null;
  thread_root_id: number | null;
  author_name: string;
  body: string;
  occurred_at: string;
  status: CommentStatus;
  sla_due_at: string | null;
  sla_minutes: number | null;
  first_response_at: string | null;
  first_response_type: string | null;
  first_response_by_id: number | null;
  is_auto_handled: number;
  needs_human: number;
  knowledge_gap: number;
  sentiment: string | null;
  rating: number | null;
  tags: string;
  category_key: string | null;
  category_name: string | null;
  handled_by_id: number | null;
  completed_at: string | null;
  visibility: string;
}

const COMMENT_COLS = `c.id, c.brand_id, b.name AS brand_name, b.color AS brand_color, c.post_id, p.title AS post_title, p.is_ad, sa.platform,
  c.parent_comment_id, c.thread_root_id, c.author_name, c.body, c.occurred_at, c.status, c.sla_due_at, c.sla_minutes, c.first_response_at,
  c.first_response_type, c.first_response_by_id, c.is_auto_handled, c.needs_human, c.knowledge_gap, c.sentiment, c.rating, c.tags,
  cc.key AS category_key, cc.name AS category_name, c.handled_by_id, c.completed_at, c.visibility`;
const COMMENT_FROM = `FROM comments c JOIN brands b ON b.id = c.brand_id JOIN posts p ON p.id = c.post_id
  JOIN social_accounts sa ON sa.id = c.social_account_id LEFT JOIN comment_categories cc ON cc.id = c.category_id`;

export async function loadComments(db: DB, brandIds: number[], start: string, end: string): Promise<CRow[]> {
  if (brandIds.length === 0) return [];
  return all<CRow>(
    db,
    `SELECT ${COMMENT_COLS} ${COMMENT_FROM}
     WHERE ${sqlIn('c.brand_id', brandIds)} AND c.occurred_at >= ? AND c.occurred_at < ?
     ORDER BY c.occurred_at LIMIT 50000`,
    [start, end],
  );
}

interface RRow {
  comment_id: number;
  brand_id: number;
  source: string;
  sent_by_id: number | null;
  sent_at: string;
}

async function loadReplies(db: DB, brandIds: number[], start: string, end: string): Promise<RRow[]> {
  if (brandIds.length === 0) return [];
  return all<RRow>(
    db,
    `SELECT comment_id, brand_id, source, sent_by_id, sent_at FROM replies
     WHERE ${sqlIn('brand_id', brandIds)} AND delivery_status = 'sent' AND sent_at >= ? AND sent_at < ?`,
    [start, end],
  );
}

async function countSuggestions(db: DB, brandIds: number[], start: string, end: string): Promise<number> {
  if (brandIds.length === 0) return 0;
  const rows = await all<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM (SELECT DISTINCT comment_id, generation_round FROM ai_suggestions
       WHERE ${sqlIn('brand_id', brandIds)} AND created_at >= ? AND created_at < ?) s`,
    [start, end],
  );
  return Number(rows[0]?.n ?? 0);
}

// ---------- 小工具 ----------
const tagsOf = (c: CRow) => parseJson<string[]>(c.tags, []);
const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;
const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const NEEDS_NO_REPLY = ['spam', 'malicious', 'no_reply'];
const QUESTION_CATS = ['product_inquiry', 'price_inquiry', 'purchase_inquiry', 'usage', 'after_sales', 'other', 'general'];
const COMPLAINT_CATS = ['complaint', 'negative_review'];
const OPPORTUNITY_CATS = ['bulk_purchase', 'business_coop', 'opportunity'];
const QUESTION_INTENTS = INTENTS.filter((i) => !['praise', 'interest'].includes(i.key));

function topCounts(values: Array<[string, string]>, n: number): CountItem[] {
  const m = new Map<string, CountItem>();
  for (const [key, label] of values) {
    const it = m.get(key) ?? { key, label, count: 0 };
    it.count++;
    m.set(key, it);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, n);
}

function intentOfQuestion(c: CRow) {
  if (!QUESTION_CATS.includes(c.category_key ?? 'other') && !COMPLAINT_CATS.includes(c.category_key ?? '')) return null;
  return QUESTION_INTENTS.find((i) => i.re.test(c.body)) ?? null;
}

// ---------- 指標 ----------
export function opsMetrics(rows: CRow[], openNow: CRow[], todayCount: number, now = nowIso()): OpsMetrics {
  const by = (s: CommentStatus) => rows.filter((c) => c.status === s).length;
  const responded = rows.filter((c) => c.first_response_at);
  const needReply = rows.filter((c) => c.sla_due_at && !NEEDS_NO_REPLY.includes(c.category_key ?? ''));
  // 已有結果的（已回覆，或還沒回覆但已經超過時效）才列入達成率
  const decided = needReply.filter((c) => c.first_response_at || c.sla_due_at! < now);
  const met = decided.filter((c) => c.first_response_at && c.first_response_at <= c.sla_due_at!);
  const decided60 = needReply.filter((c) => c.first_response_at || minutesBetween(c.occurred_at, now) > 60);
  const within60 = decided60.filter((c) => c.first_response_at && minutesBetween(c.occurred_at, c.first_response_at) <= 60);
  const nearCut = new Date(Date.parse(now) + DEFAULT_NEAR_DUE_MINUTES * 60_000).toISOString();
  const waitingReply = openNow.filter((c) => c.sla_due_at && !c.first_response_at && ['pending', 'in_progress', 'transferred'].includes(c.status));
  return {
    total: rows.length,
    today: todayCount,
    pending: by('pending'),
    inProgress: by('in_progress'),
    waiting: by('waiting'),
    transferred: by('transferred'),
    done: by('done'),
    noAction: by('no_action'),
    nearDue: waitingReply.filter((c) => c.sla_due_at! >= now && c.sla_due_at! <= nearCut).length,
    overdue: waitingReply.filter((c) => c.sla_due_at! < now).length,
    avgFirstResponseMinutes: avg(responded.map((c) => Math.max(0, minutesBetween(c.occurred_at, c.first_response_at!)))),
    slaMetRate: ratio(met.length, decided.length),
    within60Rate: ratio(within60.length, decided60.length),
    needReply: needReply.length,
  };
}

export function aiMetrics(rows: CRow[], replies: RRow[], suggestions: number): AiMetrics {
  const human = replies.filter((r) => r.sent_by_id !== null && r.source !== 'auto_rule');
  const adopted = human.filter((r) => r.source === 'ai_adopted' || r.source === 'ai_edited');
  const edited = human.filter((r) => r.source === 'ai_edited');
  const auto = replies.filter((r) => r.source === 'auto_rule');
  return {
    suggestions,
    humanReplies: human.length,
    adoptionRate: ratio(adopted.length, human.length),
    editRate: ratio(edited.length, adopted.length),
    autoReplied: auto.length,
    autoRate: ratio(rows.filter((c) => c.is_auto_handled === 1).length, rows.length),
    forcedHuman: rows.filter((c) => c.needs_human === 1).length,
    knowledgeGap: rows.filter((c) => c.knowledge_gap === 1).length,
  };
}

function postVolumes(rows: CRow[], ads: boolean): PostVolume[] {
  const m = new Map<number, PostVolume>();
  for (const c of rows) {
    if ((c.is_ad === 1) !== ads) continue;
    const p = m.get(c.post_id) ?? { postId: c.post_id, title: c.post_title, platform: c.platform, brandName: c.brand_name, isAd: c.is_ad === 1, count: 0, negative: 0 };
    p.count++;
    if (c.sentiment === 'negative') p.negative++;
    m.set(c.post_id, p);
  }
  return [...m.values()].sort((a, b) => b.count - a.count).slice(0, 5);
}

export function communityMetrics(rows: CRow[], platformLabel: (p: string) => string): CommunityMetrics {
  const byPlatform = new Map<string, CountItem & { negative: number }>();
  const byBrand = new Map<string, CountItem & { negative: number; color: string }>();
  for (const c of rows) {
    const p = byPlatform.get(c.platform) ?? { key: c.platform, label: platformLabel(c.platform), count: 0, negative: 0 };
    p.count++;
    if (c.sentiment === 'negative') p.negative++;
    byPlatform.set(c.platform, p);
    const b = byBrand.get(String(c.brand_id)) ?? { key: String(c.brand_id), label: c.brand_name, color: c.brand_color, count: 0, negative: 0 };
    b.count++;
    if (c.sentiment === 'negative') b.negative++;
    byBrand.set(String(c.brand_id), b);
  }
  return {
    byPlatform: [...byPlatform.values()].sort((a, b) => b.count - a.count),
    byBrand: [...byBrand.values()].sort((a, b) => b.count - a.count),
    topPosts: postVolumes(rows, false),
    topAds: postVolumes(rows, true),
    byCategory: topCounts(rows.map((c) => [c.category_key ?? 'other', c.category_name ?? '其他']), 20),
    sentiment: {
      positive: rows.filter((c) => c.sentiment === 'positive').length,
      neutral: rows.filter((c) => c.sentiment !== 'positive' && c.sentiment !== 'negative').length,
      negative: rows.filter((c) => c.sentiment === 'negative').length,
    },
    complaints: rows.filter((c) => COMPLAINT_CATS.includes(c.category_key ?? '')).length,
    opportunities: rows.filter((c) => OPPORTUNITY_CATS.includes(c.category_key ?? '')).length,
    hotTopics: topCounts(rows.flatMap((c) => tagsOf(c).map((t) => [t, t] as [string, string])), 10),
    commonQuestions: topCounts(
      rows.flatMap((c) => {
        const i = intentOfQuestion(c);
        return i ? [[i.key, i.label] as [string, string]] : [];
      }),
      8,
    ),
  };
}

export function dailySeries(rows: CRow[], replies: RRow[], r: DateRange): DailyPoint[] {
  const points = new Map(datesIn(r).map((d) => [d, { date: d, total: 0, positive: 0, neutral: 0, negative: 0, firstResponses: 0, autoReplied: 0 }]));
  for (const c of rows) {
    const p = points.get(localDate(c.occurred_at));
    if (!p) continue;
    p.total++;
    if (c.sentiment === 'positive') p.positive++;
    else if (c.sentiment === 'negative') p.negative++;
    else p.neutral++;
    if (c.first_response_at) {
      const q = points.get(localDate(c.first_response_at));
      if (q) q.firstResponses++;
    }
  }
  for (const x of replies) {
    if (x.source !== 'auto_rule') continue;
    const p = points.get(localDate(x.sent_at));
    if (p) p.autoReplied++;
  }
  return [...points.values()];
}

export async function teamMetrics(db: DB, rows: CRow[], replies: RRow[], brandIds: number[]): Promise<TeamMemberMetrics[]> {
  const users = await all<{ id: number; name: string; role: Role }>(
    db,
    `SELECT u.id, u.name, u.role FROM users u WHERE u.is_active = 1
       AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM user_brands ub WHERE ub.user_id = u.id AND ${sqlIn('ub.brand_id', brandIds.length ? brandIds : [0])}))`,
  );
  const byId = new Map(rows.map((c) => [c.id, c]));
  return users
    .map((u) => {
      const mine = replies.filter((r) => r.sent_by_id === u.id);
      const handledIds = new Set([...mine.map((r) => r.comment_id), ...rows.filter((c) => c.handled_by_id === u.id).map((c) => c.id)]);
      const first = rows.filter((c) => c.first_response_by_id === u.id && c.first_response_at);
      const withDue = first.filter((c) => c.sla_due_at);
      const handledRows = [...handledIds].map((id) => byId.get(id)).filter((c): c is CRow => !!c);
      return {
        userId: u.id,
        name: u.name,
        role: u.role,
        replies: mine.length,
        handled: handledIds.size,
        firstResponses: first.length,
        avgFirstResponseMinutes: avg(first.map((c) => Math.max(0, minutesBetween(c.occurred_at, c.first_response_at!)))),
        lateRate: ratio(withDue.filter((c) => c.first_response_at! > c.sla_due_at!).length, withDue.length),
        aiUseRate: ratio(mine.filter((r) => r.source === 'ai_adopted' || r.source === 'ai_edited').length, mine.length),
        topCategories: topCounts(handledRows.map((c) => [c.category_key ?? 'other', c.category_name ?? '其他']), 3),
      };
    })
    .filter((m) => m.replies > 0 || m.handled > 0)
    .sort((a, b) => b.handled - a.handled || b.replies - a.replies);
}

/** 看板與報表共用的資料 */
export async function loadPeriod(db: DB, brandIds: number[], r: DateRange) {
  const { start, end } = rangeIso(r);
  const [rows, replies, suggestions] = await Promise.all([loadComments(db, brandIds, start, end), loadReplies(db, brandIds, start, end), countSuggestions(db, brandIds, start, end)]);
  return { rows, replies, suggestions };
}

export async function loadOpenNow(db: DB, brandIds: number[]): Promise<CRow[]> {
  if (brandIds.length === 0) return [];
  return all<CRow>(
    db,
    `SELECT ${COMMENT_COLS} ${COMMENT_FROM}
     WHERE ${sqlIn('c.brand_id', brandIds)} AND c.status IN ('pending', 'in_progress', 'transferred') AND c.visibility <> 'deleted' AND sa.is_active = 1`,
  );
}

export async function countToday(db: DB, brandIds: number[]): Promise<number> {
  if (brandIds.length === 0) return 0;
  const today = localDate(nowIso());
  const rows = await all<{ n: number }>(db, `SELECT COUNT(*) AS n FROM comments WHERE ${sqlIn('brand_id', brandIds)} AND occurred_at >= ?`, [
    new Date(dayStart(today)).toISOString(),
  ]);
  return Number(rows[0]?.n ?? 0);
}

export function comparison(rows: CRow[], replies: RRow[], keyOf: (c: CRow) => [string, string], replyKey: (r: RRow) => string | null, now = nowIso()): ComparisonRow[] {
  const groups = new Map<string, { label: string; rows: CRow[] }>();
  for (const c of rows) {
    const [k, label] = keyOf(c);
    const g = groups.get(k) ?? { label, rows: [] };
    g.rows.push(c);
    groups.set(k, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => {
      const ops = opsMetrics(g.rows, [], 0, now);
      const ai = aiMetrics(g.rows, replies.filter((r) => replyKey(r) === key), 0);
      return {
        key,
        label: g.label,
        total: g.rows.length,
        negative: g.rows.filter((c) => c.sentiment === 'negative').length,
        complaints: g.rows.filter((c) => COMPLAINT_CATS.includes(c.category_key ?? '')).length,
        avgFirstResponseMinutes: ops.avgFirstResponseMinutes,
        slaMetRate: ops.slaMetRate,
        autoRate: ai.autoRate,
        adoptionRate: ai.adoptionRate,
      };
    })
    .sort((a, b) => b.total - a.total);
}

// ---------- 異常事件 ----------
const TYPE_LABELS: Record<AnomalyType, string> = {
  negative_spike: '負面留言增加',
  product_issue: '產品問題集中出現',
  post_burst: '內容湧入大量留言',
  low_rating: 'Google 低星評論增加',
  repeated_question: '問題被大量重複詢問',
  hot_topic: '話題突然受到關注',
  opportunity: '潛在商業機會',
  hot_thread: '討論特別熱烈',
};

const example = (c: CRow): AnomalyExample => ({ commentId: c.id, authorName: c.author_name, body: c.body, occurredAt: c.occurred_at });
const latest = (list: CRow[], n = 3) => [...list].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).slice(0, n).map(example);

/**
 * 依參考時間偵測值得注意的事件：每個品牌各自計算，與前 7 天的平均比較。
 * rows 需包含參考時間前 8 天內的留言。
 */
export function detectAnomalies(rows: CRow[], refIso: string): Omit<AnomalyEvent, 'ack'>[] {
  const ref = Date.parse(refIso);
  const within = (c: CRow, ms: number) => {
    const t = Date.parse(c.occurred_at);
    return t <= ref && t > ref - ms;
  };
  const prior = (c: CRow, fromMs: number) => {
    const t = Date.parse(c.occurred_at);
    return t <= ref - fromMs && t > ref - fromMs - 7 * DAY;
  };
  const dayKey = localDate(ref);
  const events: Omit<AnomalyEvent, 'ack'>[] = [];
  const brands = new Map<number, { name: string; rows: CRow[] }>();
  for (const c of rows) {
    if (c.visibility === 'deleted') continue;
    const b = brands.get(c.brand_id) ?? { name: c.brand_name, rows: [] };
    b.rows.push(c);
    brands.set(c.brand_id, b);
  }
  const push = (e: Omit<AnomalyEvent, 'ack' | 'typeLabel' | 'detectedAt' | 'key'> & { subject: string }) => {
    const { subject, ...rest } = e;
    events.push({ ...rest, key: `${e.type}:${e.brandId}:${subject}:${dayKey}`, typeLabel: TYPE_LABELS[e.type], detectedAt: refIso });
  };

  for (const [brandId, b] of brands) {
    const base = { brandId, brandName: b.name };
    // 1. 負面留言突然增加（24 小時內 vs 前 7 天日均）
    const neg = b.rows.filter((c) => c.sentiment === 'negative');
    const negNow = neg.filter((c) => within(c, DAY));
    const negAvg = neg.filter((c) => prior(c, DAY)).length / 7;
    if (negNow.length >= 3 && negNow.length >= 2 * Math.max(1, negAvg)) {
      push({
        ...base, subject: 'all', type: 'negative_spike', severity: negNow.length >= 3 * Math.max(1, negAvg) ? 'high' : 'medium',
        title: `${b.name}：負面留言增加到 ${negNow.length} 則`,
        description: `最近 24 小時有 ${negNow.length} 則負面留言，前 7 天平均每天 ${negAvg.toFixed(1)} 則。建議主管確認是否有共同原因。`,
        current: negNow.length, baseline: Math.round(negAvg * 10) / 10, postId: null, link: '/inbox?tab=all', examples: latest(negNow),
      });
    }
    // 2. 某項產品問題大量出現（48 小時內，客訴／售後／負面留言的同一標籤 ≥ 3）
    const issues = b.rows.filter((c) => within(c, 2 * DAY) && (['complaint', 'after_sales', 'negative_review'].includes(c.category_key ?? '') || c.sentiment === 'negative'));
    const issueTags = new Map<string, CRow[]>();
    for (const c of issues) for (const t of tagsOf(c)) issueTags.set(t, [...(issueTags.get(t) ?? []), c]);
    const issueTopicTags = new Set<string>();
    for (const [tag, list] of issueTags) {
      if (list.length < 3 || ['負面情緒', '高優先處理', '客訴'].includes(tag)) continue;
      issueTopicTags.add(tag);
      push({
        ...base, subject: tag, type: 'product_issue', severity: list.length >= 5 ? 'high' : 'medium',
        title: `${b.name}：「${tag}」相關問題 ${list.length} 則`,
        description: `最近 48 小時有 ${list.length} 則客訴、售後或負面留言提到「${tag}」，可能是產品或服務的共同問題，建議通知產品／客服單位。`,
        current: list.length, baseline: null, postId: null, link: `/inbox?tab=all&q=${encodeURIComponent(tag)}`, examples: latest(list),
      });
    }
    // 3. 某篇內容突然湧入大量留言（2 小時內 ≥ 8，或 24 小時內 ≥ 10 且為平常 3 倍）
    const posts = new Map<number, CRow[]>();
    for (const c of b.rows) posts.set(c.post_id, [...(posts.get(c.post_id) ?? []), c]);
    for (const [postId, list] of posts) {
      const h2 = list.filter((c) => within(c, 2 * 3600_000));
      const d1 = list.filter((c) => within(c, DAY));
      const avgPrior = list.filter((c) => prior(c, DAY)).length / 7;
      if (h2.length >= 8 || (d1.length >= 10 && d1.length >= 3 * Math.max(1, avgPrior))) {
        const n = h2.length >= 8 ? h2 : d1;
        push({
          ...base, subject: String(postId), type: 'post_burst', severity: n.filter((c) => c.sentiment === 'negative').length >= 3 ? 'high' : 'medium',
          title: `「${list[0].post_title}」湧入 ${n.length} 則留言`,
          description: `${h2.length >= 8 ? '最近 2 小時' : '最近 24 小時'}這篇${list[0].is_ad ? '廣告' : '內容'}有 ${n.length} 則新留言，其中負面 ${n.filter((c) => c.sentiment === 'negative').length} 則。可到「相似留言」批次處理重複的問題。`,
          current: n.length, baseline: Math.round(avgPrior * 10) / 10, postId, link: `/inbox?tab=all&postId=${postId}`, examples: latest(n),
        });
      }
    }
    // 4. Google 低星評論增加（7 天內 ≤ 2 星 ≥ 2 則，且比前 7 天多）
    const low = b.rows.filter((c) => c.platform === 'google' && c.rating !== null && c.rating <= 2 && !c.parent_comment_id);
    const lowNow = low.filter((c) => within(c, 7 * DAY));
    const lowPrev = low.filter((c) => {
      const t = Date.parse(c.occurred_at);
      return t <= ref - 7 * DAY && t > ref - 14 * DAY;
    });
    if (lowNow.length >= 2 && lowNow.length > lowPrev.length) {
      push({
        ...base, subject: 'google', type: 'low_rating', severity: lowNow.length >= 4 ? 'high' : 'medium',
        title: `${b.name}：Google 低星評論 ${lowNow.length} 則`,
        description: `最近 7 天有 ${lowNow.length} 則 1～2 星評論（前一週 ${lowPrev.length} 則）。低星評論會直接影響商家評分，建議盡快公開回應。`,
        current: lowNow.length, baseline: lowPrev.length, postId: null, link: '/inbox?tab=all&platform=google', examples: latest(lowNow),
      });
    }
    // 5. 某個問題被大量重複詢問（24 小時內同類問題 ≥ 5）
    const intents = new Map<string, { label: string; list: CRow[] }>();
    for (const c of b.rows.filter((x) => within(x, DAY))) {
      const i = intentOfQuestion(c);
      if (!i) continue;
      const g = intents.get(i.key) ?? { label: i.label, list: [] };
      g.list.push(c);
      intents.set(i.key, g);
    }
    for (const [key, g] of intents) {
      if (g.list.length < 5) continue;
      push({
        ...base, subject: key, type: 'repeated_question', severity: g.list.length >= 10 ? 'medium' : 'low',
        title: `${b.name}：「${g.label}」被問了 ${g.list.length} 次`,
        description: `最近 24 小時有 ${g.list.length} 則留言在${g.label.replace(/^詢問/, '問')}。建議到「相似留言」批次回覆，並考慮在貼文或知識庫補充說明。`,
        current: g.list.length, baseline: null, postId: null, link: '/batch', examples: latest(g.list),
      });
    }
    // 6. 特定話題突然受到關注（24 小時內標籤 ≥ 4 且為前 7 天日均 3 倍）
    const tagNow = new Map<string, CRow[]>();
    const tagPrior = new Map<string, number>();
    for (const c of b.rows) {
      for (const t of tagsOf(c)) {
        if (within(c, DAY)) tagNow.set(t, [...(tagNow.get(t) ?? []), c]);
        else if (prior(c, DAY)) tagPrior.set(t, (tagPrior.get(t) ?? 0) + 1);
      }
    }
    for (const [tag, list] of tagNow) {
      const a = (tagPrior.get(tag) ?? 0) / 7;
      if (list.length < 4 || list.length < 3 * Math.max(1, a) || issueTopicTags.has(tag) || ['詢價', '負面情緒', '高優先處理'].includes(tag)) continue;
      push({
        ...base, subject: tag, type: 'hot_topic', severity: 'low',
        title: `${b.name}：「${tag}」話題熱度上升`,
        description: `最近 24 小時有 ${list.length} 則留言提到「${tag}」，前 7 天平均每天 ${a.toFixed(1)} 則。可以考慮順勢製作相關內容。`,
        current: list.length, baseline: Math.round(a * 10) / 10, postId: null, link: `/inbox?tab=all&q=${encodeURIComponent(tag)}`, examples: latest(list),
      });
    }
    // 7. 潛在商業機會（48 小時內）
    const opp = b.rows.filter((c) => within(c, 2 * DAY) && OPPORTUNITY_CATS.includes(c.category_key ?? ''));
    if (opp.length > 0) {
      const open = opp.filter((c) => !c.first_response_at);
      push({
        ...base, subject: 'all', type: 'opportunity', severity: open.length ? 'medium' : 'low',
        title: `${b.name}：${opp.length} 則潛在商機`,
        description: `最近 48 小時有 ${opp.length} 則大量採購、商業合作或潛在商機留言${open.length ? `，其中 ${open.length} 則尚未回覆` : '，都已回覆'}。建議盡快轉交業務窗口。`,
        current: opp.length, baseline: null, postId: null, link: '/inbox?tab=all&category=bulk_purchase', examples: latest(opp),
      });
    }
    // 8. 某則留言或討論特別受到關注（24 小時內同一串 ≥ 4 則接續留言）
    const threads = new Map<number, CRow[]>();
    for (const c of b.rows) if (c.thread_root_id && within(c, DAY)) threads.set(c.thread_root_id, [...(threads.get(c.thread_root_id) ?? []), c]);
    for (const [rootId, list] of threads) {
      if (list.length < 4) continue;
      const root = b.rows.find((c) => c.id === rootId);
      push({
        ...base, subject: String(rootId), type: 'hot_thread', severity: list.some((c) => c.sentiment === 'negative') ? 'medium' : 'low',
        title: `一則留言引發 ${list.length} 則討論`,
        description: `「${(root?.body ?? list[0].body).slice(0, 40)}」底下最近 24 小時有 ${list.length} 則接續留言，可能正在形成討論，建議留意走向。`,
        current: list.length, baseline: null, postId: list[0].post_id, link: `/inbox/${rootId}`, examples: latest(list),
      });
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  return events.sort((a, b) => order[a.severity] - order[b.severity] || b.current - a.current);
}

// ---------- 社群洞察 ----------
const NEED_RE = /希望|能不能|可不可以|可以出|建議|想要有|推出|什麼時候(會|有|出)|出.{0,4}(版|款|色)|多一點|加入/;
const BARRIERS: Array<[RegExp, string]> = [
  [/太貴|好貴|有點貴|價格.{0,3}高|預算/, '價格偏高'],
  [/運費|免運/, '運費'],
  [/缺貨|沒貨|賣完|買不到|補貨/, '缺貨／買不到'],
  [/門市|太遠|附近/, '購買地點不便'],
  [/等太久|多久到|出貨慢|還沒(收到|出貨)/, '出貨等待時間'],
  [/不知道.{0,4}(選|買|哪)|差別|差異|哪一款/, '不知道怎麼選'],
];

const insightExample = (c: CRow, platformLabel: (p: string) => string): InsightExample => ({
  commentId: c.id,
  authorName: c.author_name,
  body: c.body,
  brandName: c.brand_name,
  platform: platformLabel(c.platform),
});

function groupItems(list: Array<{ label: string; c: CRow }>, platformLabel: (p: string) => string, n = 6): InsightItem[] {
  const m = new Map<string, CRow[]>();
  for (const { label, c } of list) m.set(label, [...(m.get(label) ?? []), c]);
  return [...m.entries()]
    .map(([label, cs]) => ({
      label,
      count: cs.length,
      examples: [...cs].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).slice(0, 3).map((c) => insightExample(c, platformLabel)),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

const byTag = (rows: CRow[], skip: string[] = []) =>
  rows.flatMap((c) => {
    const tags = tagsOf(c).filter((t) => !skip.includes(t));
    return (tags.length ? tags : [c.category_name ?? '其他']).map((label) => ({ label, c }));
  });

const GENERIC_TAGS = ['詢價', '負面情緒', '高優先處理', '客訴', '產品問題', '稱讚'];

export function buildInsights(rows: CRow[], platformLabel: (p: string) => string): InsightSection[] {
  const visible = rows.filter((c) => c.visibility !== 'deleted' && !['spam', 'malicious'].includes(c.category_key ?? ''));
  const questions = visible.filter((c) => QUESTION_CATS.includes(c.category_key ?? '') && c.category_key !== 'general');
  const complaints = visible.filter((c) => COMPLAINT_CATS.includes(c.category_key ?? ''));
  const product = visible.filter((c) => c.category_key === 'after_sales' || (COMPLAINT_CATS.includes(c.category_key ?? '') && tagsOf(c).some((t) => !GENERIC_TAGS.includes(t))));
  const praise = visible.filter((c) => c.category_key === 'praise' || (c.sentiment === 'positive' && c.category_key === 'general'));
  const opps = visible.filter((c) => OPPORTUNITY_CATS.includes(c.category_key ?? ''));

  const hotQuestions = groupItems(
    questions.flatMap((c) => {
      const i = intentOfQuestion(c);
      return i ? [{ label: i.label, c }] : [];
    }),
    platformLabel,
  );
  const hotTopics = groupItems(byTag(visible, GENERIC_TAGS), platformLabel, 8);
  const faqs = groupItems(byTag(questions, GENERIC_TAGS), platformLabel);
  const complaintItems = groupItems(byTag(complaints, GENERIC_TAGS), platformLabel);
  const productItems = groupItems(byTag(product, GENERIC_TAGS), platformLabel);
  const needs = groupItems(visible.filter((c) => NEED_RE.test(c.body)).flatMap((c) => byTag([c], GENERIC_TAGS).slice(0, 1)), platformLabel);
  const barriers = groupItems(
    visible.flatMap((c) => BARRIERS.filter(([re]) => re.test(c.body)).map(([, label]) => ({ label, c }))),
    platformLabel,
  );
  const oppItems = groupItems(opps.map((c) => ({ label: c.category_name ?? '潛在商機', c })), platformLabel);
  const positive = groupItems(byTag(praise, GENERIC_TAGS), platformLabel);

  // 值得製作內容的主題：由常見疑問、使用問題、購買阻力與好評整理
  const ideas: InsightItem[] = [];
  const usage = groupItems(byTag(visible.filter((c) => c.category_key === 'usage'), GENERIC_TAGS), platformLabel, 3);
  for (const u of usage) ideas.push({ label: `「${u.label}」使用教學（${u.count} 則相關詢問）`, count: u.count, examples: u.examples });
  for (const f of faqs.slice(0, 3)) if (!usage.some((u) => u.label === f.label)) ideas.push({ label: `「${f.label}」常見問題整理`, count: f.count, examples: f.examples });
  for (const b of barriers.slice(0, 2)) ideas.push({ label: `說明「${b.label}」：降低購買阻力`, count: b.count, examples: b.examples });
  for (const p of positive.slice(0, 2)) ideas.push({ label: `顧客好評分享：${p.label}`, count: p.count, examples: p.examples });

  return [
    { key: 'hot_questions', title: '熱門問題', description: '大家最常問的問題類型，可以補充到貼文說明或知識庫。', items: hotQuestions },
    { key: 'hot_topics', title: '熱門話題', description: '留言中最常被提到的產品、服務與主題。', items: hotTopics },
    { key: 'faqs', title: '顧客常見疑問', description: '產品、價格、購買與使用方式的詢問，依主題整理。', items: faqs },
    { key: 'complaints', title: '常見抱怨', description: '客訴與負面評論集中在哪些主題。', items: complaintItems },
    { key: 'product_issues', title: '產品問題', description: '售後與客訴中提到的具體產品或零件問題，可提供產品與品管單位參考。', items: productItems },
    { key: 'needs', title: '使用者需求', description: '顧客希望品牌推出或改善的地方。', items: needs },
    { key: 'barriers', title: '購買阻力', description: '讓顧客猶豫、沒有下單的原因。', items: barriers },
    { key: 'opportunities', title: '潛在商機', description: '大量採購、團購、合作邀約等可能帶來營收的留言。', items: oppItems },
    { key: 'positive', title: '品牌正面反饋', description: '顧客最喜歡的地方，可作為行銷素材。', items: positive },
    { key: 'content_ideas', title: '值得製作內容的主題', description: '由常見疑問、購買阻力與好評整理出的內容建議。', items: ideas.slice(0, 8) },
  ];
}

// ---------- 報表重點 ----------
const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const mins = (x: number | null) => (x === null ? '—' : x < 60 ? `${Math.round(x)} 分鐘` : `${(x / 60).toFixed(1)} 小時`);

export function highlights(
  ops: OpsMetrics,
  prevOps: OpsMetrics,
  ai: AiMetrics,
  community: CommunityMetrics,
  anomalies: Array<Pick<AnomalyEvent, 'severity' | 'title'>>,
): string[] {
  const out: string[] = [];
  const diff = prevOps.total ? Math.round(((ops.total - prevOps.total) / prevOps.total) * 100) : null;
  out.push(`共收到 ${ops.total} 則留言${diff === null ? '' : `，比前一期${diff >= 0 ? `增加 ${diff}%` : `減少 ${-diff}%`}`}。`);
  if (ops.slaMetRate !== null) {
    out.push(`回覆時效達成率 ${pct(ops.slaMetRate)}${prevOps.slaMetRate !== null ? `（前一期 ${pct(prevOps.slaMetRate)}）` : ''}，60 分鐘內首次回覆 ${pct(ops.within60Rate)}，平均首次回覆 ${mins(ops.avgFirstResponseMinutes)}。`);
  }
  if (ops.overdue > 0) out.push(`目前仍有 ${ops.overdue} 則留言已超時未回覆，需要優先處理。`);
  const neg = community.sentiment.negative;
  if (ops.total) out.push(`正面 ${community.sentiment.positive} 則、中性 ${community.sentiment.neutral} 則、負面 ${neg} 則（${pct(neg / ops.total)}）；客訴 ${community.complaints} 則，潛在商機 ${community.opportunities} 則。`);
  if (ai.humanReplies || ai.autoReplied) {
    out.push(`AI 自動回覆 ${ai.autoReplied} 則；人工回覆中 ${pct(ai.adoptionRate)} 採用 AI 建議（其中 ${pct(ai.editRate)} 有修改），知識不足 ${ai.knowledgeGap} 次。`);
  }
  if (ai.knowledgeGap >= 3) out.push(`知識不足出現 ${ai.knowledgeGap} 次，建議補充知識庫，讓 AI 能回答更多問題。`);
  if (community.commonQuestions[0]) out.push(`最常被問的是「${community.commonQuestions[0].label}」（${community.commonQuestions[0].count} 則）。`);
  if (community.hotTopics[0]) out.push(`熱門話題：${community.hotTopics.slice(0, 3).map((t) => `「${t.label}」`).join('、')}。`);
  const high = anomalies.filter((a) => a.severity === 'high');
  if (high.length) out.push(`重要異常事件 ${high.length} 件：${high.slice(0, 3).map((a) => a.title).join('；')}。`);
  return out;
}
