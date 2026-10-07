import request from 'supertest';
import { all, get, openDb, parseJson, type DB } from '../db';
import { resetAndSeed, type SeedSummary } from './index';
import { DEMO_BRANDS, DEMO_PASSWORD, DEMO_USERS } from './demo';
import { verifyPassword } from '../auth/password';
import { createApp } from '../app';
import { resetAllLoginFailures } from '../auth/rateLimit';
import {
  CONTENT_TYPES,
  DEFAULT_CATEGORIES,
  KNOWN_PLATFORMS,
  LOCK_TTL_MINUTES,
  OPEN_STATUSES,
  type CommentStatus,
} from '../../shared/constants';

const NOW = new Date('2026-10-07T06:00:00Z');
const NOW_MS = NOW.getTime();
const MIN = 60_000;
/** 「今天」：最近 10 小時 */
const TODAY_MS = 10 * 60 * MIN;

interface CommentRow {
  id: number;
  brand_id: number;
  social_account_id: number;
  post_id: number;
  parent_comment_id: number | null;
  thread_root_id: number | null;
  author_name: string;
  author_external_id: string;
  body: string;
  rating: number | null;
  like_count: number;
  occurred_at: string;
  fetched_at: string;
  status: CommentStatus;
  priority: string | null;
  tags: string;
  risk_flags: string;
  risk_level: string | null;
  sentiment: string | null;
  handling_mode: string | null;
  needs_human: number;
  assignee_id: number | null;
  original_assignee_id: number | null;
  handled_by_id: number | null;
  locked_by_id: number | null;
  locked_at: string | null;
  lock_expires_at: string | null;
  sla_minutes: number | null;
  sla_due_at: string | null;
  first_response_at: string | null;
  first_response_type: string | null;
  first_response_by_id: number | null;
  completed_at: string | null;
  visibility: string;
  is_liked: number;
  created_at: string;
  updated_at: string;
  // join
  cat: string;
  brand_code: string;
  platform: string;
  account_type: string;
  account_brand: number;
  account_name: string;
  content_type: string;
  is_ad: number;
  ad_campaign: string | null;
  post_brand: number;
  post_account: number;
}

interface ReplyRow {
  id: number;
  comment_id: number;
  brand_id: number;
  body: string;
  source: string;
  sent_by_id: number | null;
  status_after: string | null;
  platform_reply_id: string | null;
  delivery_status: string;
  sent_at: string;
}

const t = (iso: string | null) => (iso === null ? NaN : Date.parse(iso));
const tags = (c: CommentRow) => parseJson<string[]>(c.tags, []);
const flags = (c: CommentRow) => parseJson<string[]>(c.risk_flags, []);
const isToday = (c: CommentRow) => NOW_MS - t(c.occurred_at) <= TODAY_MS;

function loadComments(db: DB): CommentRow[] {
  return all<CommentRow>(
    db,
    `SELECT c.*, cc.key AS cat, b.code AS brand_code, a.platform, a.account_type, a.brand_id AS account_brand, a.name AS account_name,
            p.content_type, p.is_ad, p.ad_campaign, p.brand_id AS post_brand, p.social_account_id AS post_account
     FROM comments c
     JOIN posts p ON p.id = c.post_id
     JOIN social_accounts a ON a.id = c.social_account_id
     JOIN brands b ON b.id = c.brand_id
     LEFT JOIN comment_categories cc ON cc.id = c.category_id
     ORDER BY c.id`,
  );
}

let db: DB;
let summary: SeedSummary;
let comments: CommentRow[];
let replies: ReplyRow[];
let byId: Map<number, CommentRow>;
let brandIdByCode: Map<string, number>;
/** userId → 可存取的品牌（管理員為 'all'） */
let access: Map<number, Set<number> | 'all'>;
let userIdByEmail: Map<string, number>;

const canAccess = (userId: number | null, brandId: number) => {
  if (userId === null) return true;
  const a = access.get(userId);
  return a === 'all' || (a !== undefined && a.has(brandId));
};

beforeAll(() => {
  db = openDb(':memory:');
  summary = resetAndSeed(db, { now: NOW });
  comments = loadComments(db);
  replies = all<ReplyRow>(db, 'SELECT * FROM replies ORDER BY id');
  byId = new Map(comments.map((c) => [c.id, c]));
  brandIdByCode = new Map(all<{ id: number; code: string }>(db, 'SELECT id, code FROM brands').map((b) => [b.code, b.id]));
  access = new Map();
  userIdByEmail = new Map();
  for (const u of all<{ id: number; email: string; role: string }>(db, 'SELECT id, email, role FROM users')) {
    userIdByEmail.set(u.email, u.id);
    if (u.role === 'admin') access.set(u.id, 'all');
    else
      access.set(
        u.id,
        new Set(all<{ brand_id: number }>(db, 'SELECT brand_id FROM user_brands WHERE user_id = ?', [u.id]).map((r) => r.brand_id)),
      );
  }
});

describe('示範資料：數量與涵蓋範圍', () => {
  it('品牌、人員、帳號、貼文、留言數量合理，摘要與資料庫一致', () => {
    expect(summary.brands).toBe(3);
    expect(summary.users).toBe(4);
    expect(summary.accounts).toBe(15);
    expect(summary.posts).toBeGreaterThanOrEqual(30);
    expect(summary.posts).toBeLessThanOrEqual(40);
    expect(summary.comments).toBeGreaterThanOrEqual(150);
    expect(summary.comments).toBeLessThanOrEqual(190);
    expect(summary.comments).toBe(comments.length);
    expect(summary.replies).toBe(replies.length);
    expect(summary.replies).toBeGreaterThan(60);
    expect(summary.auditLogs).toBe(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM audit_logs')!.n);
  });

  it('16 種留言類型都至少出現 2 次', () => {
    for (const cat of DEFAULT_CATEGORIES) {
      expect(comments.filter((c) => c.cat === cat.key).length, cat.key).toBeGreaterThanOrEqual(2);
    }
    expect(comments.every((c) => c.cat)).toBe(true);
  });

  it('7 種內容型態與 4 個平台都有貼文與留言', () => {
    const postTypes = new Set(all<{ content_type: string }>(db, 'SELECT content_type FROM posts').map((p) => p.content_type));
    for (const ct of CONTENT_TYPES) {
      expect(postTypes.has(ct), ct).toBe(true);
      expect(comments.some((c) => c.content_type === ct), ct).toBe(true);
    }
    for (const p of KNOWN_PLATFORMS) expect(comments.some((c) => c.platform === p), p).toBe(true);
    // 廣告必須標記 is_ad 與活動名稱
    for (const p of all<{ content_type: string; is_ad: number; ad_campaign: string | null }>(db, 'SELECT * FROM posts')) {
      expect(p.is_ad === 1).toBe(p.content_type === 'ad');
      expect(Boolean(p.ad_campaign)).toBe(p.content_type === 'ad');
    }
  });

  it('社群帳號：每品牌 5 個，信義店 Google 商家為授權過期示範', () => {
    const accounts = all<{ brand_id: number; platform: string; account_type: string; name: string; external_id: string; status: string; adapter_key: string; last_synced_at: string }>(
      db,
      'SELECT * FROM social_accounts',
    );
    for (const id of brandIdByCode.values()) expect(accounts.filter((a) => a.brand_id === id)).toHaveLength(5);
    for (const a of accounts) expect(a.adapter_key).toBe(`mock:${a.platform}`);
    const xinyi = accounts.find((a) => a.name === '日日咖啡 信義店')!;
    expect(xinyi.external_id.startsWith('err-')).toBe(true);
    expect(xinyi.status).toBe('error');
    expect(accounts.filter((a) => a.status !== 'connected')).toHaveLength(1);
    const handles = all<{ handle: string }>(db, "SELECT handle FROM social_accounts WHERE account_type = 'ig_account' ORDER BY id").map((a) => a.handle);
    expect(handles).toEqual(['@clearpure.tw', '@dailycoffee.tw', '@mori.baby']);
    // 信義店的評論都早於授權過期（最後同步）時間
    for (const c of comments.filter((c) => c.account_name === '日日咖啡 信義店')) {
      expect(t(c.fetched_at)).toBeLessThanOrEqual(t(xinyi.last_synced_at));
    }
  });

  it('每個 Google 商家帳號剛好一個商家檔案，評論都掛在上面且有星等', () => {
    const google = all<{ id: number }>(db, "SELECT id FROM social_accounts WHERE platform = 'google'");
    expect(google).toHaveLength(4);
    for (const a of google) {
      const posts = all<{ content_type: string }>(db, 'SELECT content_type FROM posts WHERE social_account_id = ?', [a.id]);
      expect(posts).toHaveLength(1);
      expect(posts[0].content_type).toBe('business_profile');
    }
    for (const c of comments) {
      if (c.platform === 'google') {
        expect(c.content_type).toBe('business_profile');
        expect(c.rating).toBeGreaterThanOrEqual(1);
        expect(c.rating).toBeLessThanOrEqual(5);
        expect(c.parent_comment_id).toBeNull();
      } else {
        expect(c.rating).toBeNull();
      }
    }
  });
});

describe('示範資料：劇情情境', () => {
  it('規格書範例：澄淨 Facebook 廣告下的詢價＋漏水客訴', () => {
    const c = comments.find((c) => c.body === '這個多少錢？我上次買的還漏水，你們品質到底怎樣？')!;
    expect(c).toBeDefined();
    expect(c.brand_code).toBe('CLEAR');
    expect(c.platform).toBe('facebook');
    expect(c.content_type).toBe('ad');
    expect(c.is_ad).toBe(1);
    expect(c.cat).toBe('complaint');
    expect(tags(c)).toEqual(expect.arrayContaining(['詢價', '產品問題', '負面情緒', '高優先處理']));
    expect(flags(c)).toEqual(['complaint']);
    expect(c.priority).toBe('high');
    expect(c.sentiment).toBe('negative');
    expect(c.needs_human).toBe(1);
  });

  it('爆量：日日咖啡 IG 耶誕禮盒廣告 40 分鐘內湧入至少 22 則價格詢問，多數未處理、未指派', () => {
    const surge = comments.filter(
      (c) =>
        c.brand_code === 'DAILY' &&
        c.platform === 'instagram' &&
        c.content_type === 'ad' &&
        c.cat === 'price_inquiry' &&
        NOW_MS - t(c.occurred_at) <= 40 * MIN,
    );
    expect(surge.length).toBeGreaterThanOrEqual(22);
    expect(new Set(surge.map((c) => c.post_id)).size).toBe(1);
    expect(surge[0].ad_campaign).toContain('耶誕');
    expect(new Set(surge.map((c) => c.body)).size).toBe(surge.length);
    expect(new Set(surge.map((c) => c.author_external_id)).size).toBe(surge.length);
    const untouched = surge.filter((c) => c.status === 'pending' && c.assignee_id === null);
    expect(untouched.length).toBeGreaterThanOrEqual(Math.ceil(surge.length * 0.8));
    for (const phrase of ['多少錢？', '價格？', '請問售價', '一組多少？', '+1 想知道價錢', '怎麼賣', '禮盒價格多少呢', '有優惠價嗎']) {
      expect(surge.some((c) => c.body === phrase), phrase).toBe(true);
    }
  });

  it('產品問題集中：澄淨 24 小時內至少 6 則濾芯漏水，橫跨粉專、社團、Google', () => {
    const leaks = comments.filter(
      (c) =>
        c.brand_code === 'CLEAR' &&
        tags(c).includes('濾芯') &&
        tags(c).includes('漏水') &&
        NOW_MS - t(c.occurred_at) <= 24 * 60 * MIN,
    );
    expect(leaks.length).toBeGreaterThanOrEqual(6);
    const types = new Set(leaks.map((c) => c.account_type));
    for (const at of ['fb_page', 'fb_group', 'google_business']) expect(types.has(at), at).toBe(true);
  });

  it('低星評論增加：澄淨台北旗艦店近 2 天多則 1–2 星，更早之前都是 4–5 星', () => {
    const reviews = comments.filter((c) => c.account_name === '澄淨家電 台北旗艦店');
    const recent = reviews.filter((c) => NOW_MS - t(c.occurred_at) <= 48 * 60 * MIN);
    const older = reviews.filter((c) => NOW_MS - t(c.occurred_at) > 48 * 60 * MIN);
    expect(recent.filter((c) => c.rating! <= 2).length).toBeGreaterThanOrEqual(4);
    expect(older.length).toBeGreaterThanOrEqual(3);
    expect(older.every((c) => c.rating! >= 4)).toBe(true);
  });

  it('商機：日日咖啡尾牙 200 份、合作邀約、辦公室長期配送；澄淨大量採購', () => {
    const daily = comments.filter((c) => c.brand_code === 'DAILY');
    expect(daily.some((c) => c.cat === 'bulk_purchase' && c.body.includes('200 份'))).toBe(true);
    expect(daily.filter((c) => c.cat === 'business_coop').length).toBeGreaterThanOrEqual(2);
    expect(daily.some((c) => c.cat === 'business_coop' && c.body.includes('Podcast'))).toBe(true);
    expect(daily.some((c) => c.cat === 'opportunity' && c.body.includes('辦公室'))).toBe(true);
    expect(comments.some((c) => c.brand_code === 'CLEAR' && c.cat === 'bulk_purchase' && /飯店|辦公室/.test(c.body))).toBe(true);
  });

  it('小森：安全、敏感與退款留言都標記風險並需要人工處理', () => {
    const mori = comments.filter((c) => c.brand_code === 'MORI');
    const plasticizer = mori.find((c) => c.body.includes('塑化劑'))!;
    expect(flags(plasticizer)).toEqual(expect.arrayContaining(['safety', 'sensitive']));
    const hip = mori.find((c) => c.body.includes('髖關節'))!;
    expect(flags(hip)).toContain('safety');
    const swallow = mori.find((c) => c.body.includes('吞'))!;
    expect(swallow.risk_level).toBe('high');
    expect(swallow.priority).toBe('high');
    const refund = mori.find((c) => c.body === '收到的奶瓶有裂痕，要退款')!;
    expect(flags(refund)).toContain('refund');
    for (const c of [plasticizer, hip, swallow, refund]) expect(c.needs_human, c.body).toBe(1);
    expect(mori.some((c) => c.handling_mode === 'manual' && c.cat === 'complaint')).toBe(true);
  });

  it('垃圾訊息、惡意留言、無需回覆都存在；部分垃圾訊息仍在待處理', () => {
    const spam = comments.filter((c) => c.cat === 'spam');
    expect(spam.some((c) => /LINE/.test(c.body))).toBe(true);
    expect(spam.some((c) => c.status === 'pending')).toBe(true);
    expect(spam.every((c) => flags(c).includes('spam') && c.sla_due_at === null)).toBe(true);
    expect(comments.filter((c) => c.cat === 'malicious').every((c) => flags(c).includes('malicious'))).toBe(true);
    expect(comments.some((c) => c.cat === 'no_reply' && /^[\p{Extended_Pictographic}\s]+$/u.test(c.body))).toBe(true);
    expect(comments.some((c) => c.cat === 'no_reply' && c.body.startsWith('@'))).toBe(true);
  });

  it('隱藏與刪除：一則惡意留言由主管隱藏、一則垃圾訊息經確認後刪除', () => {
    const actions = all<{ comment_id: number; action: string; suggested_by: string; requested_by_id: number; confirmed_by_id: number | null; reason: string }>(
      db,
      'SELECT * FROM comment_actions',
    );
    const hidden = comments.filter((c) => c.visibility === 'hidden');
    expect(hidden).toHaveLength(1);
    expect(hidden[0].cat).toBe('malicious');
    const hide = actions.find((a) => a.comment_id === hidden[0].id && a.action === 'hide')!;
    const lead = userIdByEmail.get('lead@demo.tw');
    expect(hide).toMatchObject({ suggested_by: 'user', requested_by_id: lead, confirmed_by_id: lead });
    expect(hide.reason.length).toBeGreaterThan(0);

    const deleted = comments.filter((c) => c.visibility === 'deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0].cat).toBe('spam');
    const del = actions.find((a) => a.comment_id === deleted[0].id && a.action === 'delete')!;
    expect(del.confirmed_by_id).not.toBeNull();
    expect(del.reason.trim().length).toBeGreaterThan(0);

    // 按讚的留言都有 like 動作，且平台支援按讚（目前只有 Facebook）
    const liked = comments.filter((c) => c.is_liked === 1);
    expect(liked.filter((c) => c.cat === 'praise').length).toBeGreaterThanOrEqual(3);
    for (const c of liked) {
      expect(c.platform).toBe('facebook');
      expect(actions.some((a) => a.comment_id === c.id && a.action === 'like')).toBe(true);
    }
    for (const a of actions) {
      if (a.action === 'hide' || a.action === 'delete') expect(byId.get(a.comment_id)!.visibility).not.toBe('visible');
    }
  });

  it('留言串：至少 6 個「顧客留言 → 品牌回覆 → 顧客追問」，追問讓原留言結案', () => {
    const followUpAudits = all<{ comment_id: number; detail: string; created_at: string }>(
      db,
      "SELECT * FROM audit_logs WHERE action = 'comment.follow_up_received'",
    );
    const threads = comments.filter((parent) => {
      const followUp = comments.find(
        (c) =>
          c.parent_comment_id === parent.id &&
          c.author_external_id === parent.author_external_id &&
          parent.first_response_at !== null &&
          t(c.occurred_at) > t(parent.first_response_at),
      );
      if (!followUp) return false;
      const parentReplies = replies.filter((r) => r.comment_id === parent.id);
      expect(parentReplies.length).toBeGreaterThanOrEqual(1);
      expect(parentReplies[0].status_after).toBe('waiting');
      expect(parent.status).toBe('done');
      expect(parent.completed_at).toBe(followUp.occurred_at);
      const a = followUpAudits.find((x) => x.comment_id === parent.id)!;
      expect(a).toBeDefined();
      expect(parseJson<{ followUpCommentId: number }>(a.detail, { followUpCommentId: 0 }).followUpCommentId).toBe(followUp.id);
      return true;
    });
    expect(threads.length).toBeGreaterThanOrEqual(6);
    expect(followUpAudits.length).toBe(threads.length);
    // 至少有追問仍在待處理（有自己的時效）
    const pendingFollowUps = comments.filter(
      (c) => c.parent_comment_id !== null && c.status === 'pending' && c.sla_due_at !== null && byId.get(c.parent_comment_id)!.author_external_id === c.author_external_id,
    );
    expect(pendingFollowUps.length).toBeGreaterThanOrEqual(1);
    // 也有其他網友在別人的留言底下回覆（例如「+1 我家也漏水」）
    const others = comments.filter((c) => c.parent_comment_id !== null && byId.get(c.parent_comment_id)!.author_external_id !== c.author_external_id);
    expect(others.length).toBeGreaterThanOrEqual(4);
    expect(others.some((c) => c.body.includes('+1'))).toBe(true);
  });

  it('熱門留言：至少 2 則 50～120 讚，其中一則是有留言串的客訴', () => {
    const popular = comments.filter((c) => c.like_count >= 50 && c.like_count <= 120);
    expect(popular.length).toBeGreaterThanOrEqual(2);
    const complaintThread = popular.find((c) => c.cat === 'complaint' && comments.some((x) => x.thread_root_id === c.id));
    expect(complaintThread).toBeDefined();
    // 其他留言多數 0～5 讚
    expect(comments.filter((c) => c.like_count <= 5).length / comments.length).toBeGreaterThan(0.85);
  });

  it('同一位留言者可以留言多次（author_external_id 穩定）', () => {
    const counts = new Map<string, number>();
    for (const c of comments) counts.set(c.author_external_id, (counts.get(c.author_external_id) ?? 0) + 1);
    expect([...counts.values()].filter((n) => n > 1).length).toBeGreaterThanOrEqual(5);
    // 同一個 id 一定是同一個名字
    const names = new Map<string, string>();
    for (const c of comments) {
      expect(names.get(c.author_external_id) ?? c.author_name).toBe(c.author_name);
      names.set(c.author_external_id, c.author_name);
    }
  });
});

describe('示範資料：一致性', () => {
  it('留言、貼文、帳號屬於同一個品牌', () => {
    for (const c of comments) {
      expect(c.post_brand, c.body).toBe(c.brand_id);
      expect(c.account_brand, c.body).toBe(c.brand_id);
      expect(c.post_account, c.body).toBe(c.social_account_id);
    }
  });

  it('留言串：最上層 thread_root_id 為 NULL，回覆指向最上層留言且在同一篇貼文', () => {
    for (const c of comments) {
      if (c.parent_comment_id === null) {
        expect(c.thread_root_id).toBeNull();
        continue;
      }
      const parent = byId.get(c.parent_comment_id)!;
      expect(parent.post_id).toBe(c.post_id);
      expect(t(parent.occurred_at)).toBeLessThan(t(c.occurred_at));
      let root = parent;
      while (root.parent_comment_id !== null) root = byId.get(root.parent_comment_id)!;
      expect(c.thread_root_id).toBe(root.id);
    }
  });

  it('時間：留言、取得、處理時間都合理且不晚於現在', () => {
    let maxAgeMs = 0;
    for (const c of comments) {
      const occurred = t(c.occurred_at);
      const fetchDelay = (t(c.fetched_at) - occurred) / MIN;
      expect(t(c.fetched_at)).toBeLessThanOrEqual(NOW_MS);
      if (c.platform === 'google') {
        expect(fetchDelay).toBeGreaterThanOrEqual(5);
        expect(fetchDelay).toBeLessThanOrEqual(15);
      } else {
        expect(fetchDelay).toBeGreaterThanOrEqual(1);
        expect(fetchDelay).toBeLessThanOrEqual(3);
      }
      for (const ts of [c.first_response_at, c.completed_at, c.locked_at, c.updated_at]) {
        if (ts !== null) {
          expect(t(ts)).toBeLessThanOrEqual(NOW_MS);
          expect(t(ts)).toBeGreaterThanOrEqual(t(c.fetched_at));
        }
      }
      maxAgeMs = Math.max(maxAgeMs, NOW_MS - occurred);
      const post = get<{ published_at: string }>(db, 'SELECT published_at FROM posts WHERE id = ?', [c.post_id])!;
      expect(t(post.published_at)).toBeLessThan(occurred);
    }
    expect(maxAgeMs).toBeLessThanOrEqual(3 * 24 * 60 * MIN);
    for (const r of replies) expect(t(r.sent_at)).toBeLessThanOrEqual(NOW_MS);
  });

  it('時效：sla_minutes 取自品牌設定，sla_due_at = 留言時間 + sla_minutes，處理模式也取自品牌設定', () => {
    const settings = new Map(
      all<{ brand_id: number; category_id: number; sla_minutes: number | null; sla_enabled: number; handling_mode: string }>(
        db,
        'SELECT * FROM brand_category_settings',
      ).map((s) => [`${s.brand_id}:${s.category_id}`, s]),
    );
    for (const c of comments) {
      const catId = get<{ category_id: number }>(db, 'SELECT category_id FROM comments WHERE id = ?', [c.id])!.category_id;
      const s = settings.get(`${c.brand_id}:${catId}`)!;
      expect(c.sla_minutes).toBe(s.sla_enabled === 1 ? s.sla_minutes : null);
      expect(c.handling_mode).toBe(s.handling_mode);
      if (c.sla_minutes === null) expect(c.sla_due_at).toBeNull();
      else expect(t(c.sla_due_at)).toBe(t(c.occurred_at) + c.sla_minutes * MIN);
    }
  });

  it('狀態不變條件', () => {
    const replyCount = new Map<number, number>();
    for (const r of replies) replyCount.set(r.comment_id, (replyCount.get(r.comment_id) ?? 0) + 1);
    for (const c of comments) {
      const label = `${c.status}：${c.body}`;
      if (['pending', 'in_progress', 'transferred'].includes(c.status)) {
        expect(c.first_response_at, label).toBeNull();
        expect(c.completed_at, label).toBeNull();
        expect(replyCount.get(c.id) ?? 0, label).toBe(0);
      }
      if (c.status === 'in_progress') {
        expect(c.locked_by_id, label).not.toBeNull();
        expect(t(c.lock_expires_at)).toBe(t(c.locked_at) + LOCK_TTL_MINUTES * MIN);
        expect(t(c.lock_expires_at)).toBeGreaterThan(NOW_MS);
        expect(NOW_MS - t(c.locked_at)).toBeLessThan(LOCK_TTL_MINUTES * MIN);
      } else {
        expect(c.locked_by_id, label).toBeNull();
        expect(c.locked_at, label).toBeNull();
        expect(c.lock_expires_at, label).toBeNull();
      }
      if (c.status === 'transferred') {
        expect(c.assignee_id, label).not.toBeNull();
        expect(c.original_assignee_id, label).not.toBe(c.assignee_id);
      }
      if (c.status === 'waiting') {
        expect(c.first_response_at, label).not.toBeNull();
        expect(replyCount.get(c.id) ?? 0, label).toBeGreaterThanOrEqual(1);
        expect(c.completed_at, label).toBeNull();
      }
      if (c.status === 'done') {
        expect(c.completed_at, label).not.toBeNull();
        if (c.first_response_at) expect(t(c.completed_at)).toBeGreaterThanOrEqual(t(c.first_response_at));
      }
      if (c.status === 'no_action') {
        expect(c.completed_at, label).not.toBeNull();
        expect(c.handled_by_id, label).not.toBeNull();
      }
      if (c.first_response_at !== null) {
        expect(c.first_response_type).toBe('human');
        expect(c.first_response_by_id).not.toBeNull();
        expect(c.handled_by_id).not.toBeNull();
      } else {
        expect(c.first_response_type).toBeNull();
        expect(c.first_response_by_id).toBeNull();
      }
      if (c.original_assignee_id === null) expect(c.assignee_id).toBeNull();
      if (c.visibility !== 'visible') expect(c.status).toBe('no_action');
    }
    const inProgress = comments.filter((c) => c.status === 'in_progress').length;
    expect(inProgress).toBeGreaterThanOrEqual(2);
    expect(inProgress).toBeLessThanOrEqual(3);
    const transferredCount = comments.filter((c) => c.status === 'transferred').length;
    expect(transferredCount).toBeGreaterThanOrEqual(1);
    expect(transferredCount).toBeLessThanOrEqual(2);
  });

  it('回覆：品牌口吻、人工送出、首次回覆時間一致', () => {
    const firstByComment = new Map<number, ReplyRow>();
    for (const r of replies) if (!firstByComment.has(r.comment_id)) firstByComment.set(r.comment_id, r);
    for (const r of replies) {
      const c = byId.get(r.comment_id)!;
      expect(r.brand_id).toBe(c.brand_id);
      expect(r.source).toBe('manual');
      expect(r.delivery_status).toBe('sent');
      expect(r.platform_reply_id?.startsWith('mock-')).toBe(true);
      expect(['waiting', 'done']).toContain(r.status_after);
      expect(r.body.length).toBeGreaterThan(5);
      expect(r.sent_by_id).not.toBeNull();
    }
    for (const [commentId, r] of firstByComment) {
      const c = byId.get(commentId)!;
      expect(r.sent_at).toBe(c.first_response_at);
      expect(r.sent_by_id).toBe(c.first_response_by_id);
    }
    for (const c of comments) if (c.first_response_at) expect(firstByComment.has(c.id)).toBe(true);
    // 澄淨不用 emoji；日日咖啡活潑、常用 emoji
    const brandReplies = (code: string) => replies.filter((r) => byId.get(r.comment_id)!.brand_code === code);
    expect(brandReplies('CLEAR').some((r) => /\p{Extended_Pictographic}/u.test(r.body))).toBe(false);
    expect(brandReplies('CLEAR').filter((r) => r.body.includes('您')).length / brandReplies('CLEAR').length).toBeGreaterThan(0.8);
    expect(brandReplies('DAILY').filter((r) => /\p{Extended_Pictographic}/u.test(r.body)).length / brandReplies('DAILY').length).toBeGreaterThan(0.6);
  });

  it('負責人：回覆者、鎖定者、負責人、轉交與動作的人員都有該品牌權限；包含「指派 A、由 B 回覆」的案例', () => {
    for (const c of comments) {
      for (const uid of [c.assignee_id, c.original_assignee_id, c.handled_by_id, c.first_response_by_id, c.locked_by_id]) {
        expect(canAccess(uid, c.brand_id), `${c.body} / user ${uid}`).toBe(true);
      }
    }
    for (const r of replies) expect(canAccess(r.sent_by_id, r.brand_id)).toBe(true);
    for (const a of all<{ brand_id: number; from_user_id: number | null; to_user_id: number | null; assigned_by_id: number | null }>(
      db,
      'SELECT * FROM assignments',
    )) {
      for (const uid of [a.from_user_id, a.to_user_id, a.assigned_by_id]) expect(canAccess(uid, a.brand_id)).toBe(true);
    }
    for (const a of all<{ brand_id: number; requested_by_id: number | null; confirmed_by_id: number | null }>(db, 'SELECT * FROM comment_actions')) {
      expect(canAccess(a.requested_by_id, a.brand_id)).toBe(true);
      expect(canAccess(a.confirmed_by_id, a.brand_id)).toBe(true);
    }
    const amy = userIdByEmail.get('amy@demo.tw')!;
    const hao = userIdByEmail.get('hao@demo.tw')!;
    const lead = userIdByEmail.get('lead@demo.tw')!;
    const mismatched = comments.filter((c) => c.assignee_id !== null && c.handled_by_id !== null && c.assignee_id !== c.handled_by_id);
    expect(mismatched.some((c) => c.brand_code === 'DAILY' && c.assignee_id === amy && c.handled_by_id === hao)).toBe(true);
    expect(mismatched.some((c) => c.assignee_id === amy && c.handled_by_id === lead)).toBe(true);
    expect(comments.filter((c) => c.handled_by_id !== null && c.assignee_id !== null).length).toBeGreaterThanOrEqual(10);
  });

  it('轉交：有 assignments 紀錄（原負責人 → 新負責人，含理由）', () => {
    for (const c of comments.filter((c) => c.status === 'transferred')) {
      const rows = all<{ from_user_id: number | null; to_user_id: number; reason: string }>(
        db,
        'SELECT * FROM assignments WHERE comment_id = ? ORDER BY id',
        [c.id],
      );
      expect(rows[0].from_user_id).toBeNull();
      expect(rows[0].to_user_id).toBe(c.original_assignee_id);
      const last = rows[rows.length - 1];
      expect(last.from_user_id).toBe(c.original_assignee_id);
      expect(last.to_user_id).toBe(c.assignee_id);
      expect(last.reason.length).toBeGreaterThan(0);
    }
  });

  it('外鍵完整（PRAGMA foreign_key_check 沒有任何問題）', () => {
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });
});

describe('示範資料：時效與「此刻」的樣貌', () => {
  it('約 55% 的留言在今天（最近 10 小時），而且越接近現在越密集', () => {
    const today = comments.filter(isToday);
    const ratio = today.length / comments.length;
    expect(ratio).toBeGreaterThanOrEqual(0.45);
    expect(ratio).toBeLessThanOrEqual(0.65);
    const last2h = today.filter((c) => NOW_MS - t(c.occurred_at) <= 120 * MIN);
    expect(last2h.length).toBeGreaterThan(today.length / 2);
  });

  it('今天的留言多數待處理；更早的留言都已結案或等待對方', () => {
    const today = comments.filter(isToday);
    expect(today.filter((c) => c.status === 'pending').length).toBeGreaterThan(today.length / 2);
    for (const s of ['waiting', 'done', 'no_action'] as const) expect(today.some((c) => c.status === s), s).toBe(true);
    for (const c of comments.filter((c) => !isToday(c))) expect(['done', 'no_action', 'waiting']).toContain(c.status);
  });

  it('待處理留言有逾時、即將超時、時間充裕三種，且都在合理範圍', () => {
    const nearDue = new Map(all<{ id: number; near_due_minutes: number }>(db, 'SELECT id, near_due_minutes FROM brands').map((b) => [b.id, b.near_due_minutes]));
    const pending = comments.filter((c) => c.status === 'pending' && c.sla_due_at !== null);
    const remaining = (c: CommentRow) => (t(c.sla_due_at) - NOW_MS) / MIN;
    const overdue = pending.filter((c) => remaining(c) < 0);
    const near = pending.filter((c) => remaining(c) >= 0 && remaining(c) <= nearDue.get(c.brand_id)!);
    const comfortable = pending.filter((c) => remaining(c) > nearDue.get(c.brand_id)!);
    expect(overdue.length).toBeGreaterThanOrEqual(3);
    expect(near.length).toBeGreaterThanOrEqual(3);
    expect(comfortable.length).toBeGreaterThanOrEqual(3);
    for (const c of comments.filter((c) => (['pending', 'in_progress', 'transferred'] as CommentStatus[]).includes(c.status) && c.sla_due_at)) {
      expect(remaining(c), c.body).toBeGreaterThanOrEqual(-35);
      expect(remaining(c), c.body).toBeLessThanOrEqual(60);
    }
    expect(Math.min(...overdue.map(remaining))).toBeLessThan(-20);
    expect(Math.max(...comfortable.map(remaining))).toBeGreaterThan(45);
  });

  it('首次回覆：較早的留言約 10–15% 逾時，整體 60 分鐘內回覆率約 85%', () => {
    const older = comments.filter((c) => !isToday(c) && c.first_response_at && c.sla_due_at);
    const late = older.filter((c) => t(c.first_response_at) > t(c.sla_due_at));
    const lateRate = late.length / older.length;
    expect(lateRate).toBeGreaterThanOrEqual(0.08);
    expect(lateRate).toBeLessThanOrEqual(0.18);
    const replied = comments.filter((c) => c.first_response_at);
    const within60 = replied.filter((c) => t(c.first_response_at) - t(c.occurred_at) <= 60 * MIN).length / replied.length;
    expect(within60).toBeGreaterThanOrEqual(0.8);
    expect(within60).toBeLessThanOrEqual(0.92);
  });

  it('未結束的留言都在 OPEN_STATUSES 內', () => {
    for (const c of comments.filter((c) => !c.completed_at)) expect(OPEN_STATUSES).toContain(c.status);
  });
});

describe('示範資料：操作紀錄', () => {
  interface AuditRow {
    id: number;
    brand_id: number | null;
    comment_id: number | null;
    actor_type: string;
    actor_user_id: number | null;
    action: string;
    target_type: string | null;
    target_id: number | null;
    assignee_id_at_time: number | null;
    summary: string;
    before: string | null;
    after: string | null;
    detail: string | null;
    created_at: string;
  }
  let audits: AuditRow[];
  beforeAll(() => {
    audits = all<AuditRow>(db, 'SELECT * FROM audit_logs ORDER BY id');
  });

  it('每一則回覆都有對應的 comment.reply 紀錄（時間、人員、replyId 一致）', () => {
    const replyAudits = audits.filter((a) => a.action === 'comment.reply');
    expect(replyAudits).toHaveLength(replies.length);
    for (const r of replies) {
      const a = replyAudits.find((x) => parseJson<{ replyId?: number }>(x.detail, {}).replyId === r.id)!;
      expect(a, `reply ${r.id}`).toBeDefined();
      expect(a.comment_id).toBe(r.comment_id);
      expect(a.brand_id).toBe(r.brand_id);
      expect(a.actor_user_id).toBe(r.sent_by_id);
      expect(a.created_at).toBe(r.sent_at);
      expect(a.summary).toContain('回覆留言');
      expect(parseJson<{ status?: string }>(a.after, {}).status).toBe(r.status_after);
    }
    // 指派 A、由 B 回覆時，紀錄當下的負責人是 A
    const c = comments.find((c) => c.assignee_id !== null && c.handled_by_id !== null && c.assignee_id !== c.handled_by_id && c.first_response_at)!;
    const a = replyAudits.find((x) => x.comment_id === c.id)!;
    expect(a.assignee_id_at_time).toBe(c.assignee_id);
    expect(a.actor_user_id).toBe(c.handled_by_id);
  });

  it('指派、轉交、隱藏、刪除、按讚、狀態變更都有紀錄', () => {
    const count = (action: string) => audits.filter((a) => a.action === action).length;
    const assignments = all<{ from_user_id: number | null }>(db, 'SELECT from_user_id FROM assignments');
    expect(count('comment.assign')).toBe(assignments.filter((a) => a.from_user_id === null).length);
    expect(count('comment.transfer')).toBe(assignments.filter((a) => a.from_user_id !== null).length);
    const actions = all<{ action: string }>(db, 'SELECT action FROM comment_actions');
    for (const act of ['hide', 'delete', 'like']) {
      expect(count(`comment.${act}`), act).toBe(actions.filter((a) => a.action === act).length);
    }
    expect(count('comment.status_change')).toBe(
      comments.filter((c) => c.status === 'no_action' || c.status === 'in_progress').length,
    );
    for (const a of audits.filter((a) => a.action === 'comment.status_change')) {
      expect(parseJson<{ status?: string }>(a.before, {}).status).toBeDefined();
      expect(parseJson<{ status?: string }>(a.after, {}).status).toBe(byId.get(a.comment_id!)!.status);
    }
    expect(audits.find((a) => a.action === 'comment.transfer')!.summary).toMatch(/轉交給/);
  });

  it('紀錄時間不晚於現在、依時間排序、人員操作都有執行者、摘要為中文；最後一筆是「建立示範資料」', () => {
    for (let i = 0; i < audits.length; i++) {
      const a = audits[i];
      expect(t(a.created_at)).toBeLessThanOrEqual(NOW_MS);
      if (i > 0) expect(t(a.created_at)).toBeGreaterThanOrEqual(t(audits[i - 1].created_at));
      if (a.actor_type === 'user') expect(a.actor_user_id).not.toBeNull();
      expect(a.summary).toMatch(/[一-鿿]/);
      if (a.comment_id !== null) {
        expect(a.brand_id).toBe(byId.get(a.comment_id)!.brand_id);
        if (a.actor_user_id !== null) expect(canAccess(a.actor_user_id, a.brand_id!)).toBe(true);
      }
      expect(JSON.stringify(a)).not.toContain(DEMO_PASSWORD);
    }
    const last = audits[audits.length - 1];
    expect(last).toMatchObject({ action: 'mock.seed', actor_type: 'system', summary: '建立示範資料', created_at: NOW.toISOString() });
    expect(audits.filter((a) => a.action === 'mock.seed')).toHaveLength(1);
  });
});

describe('示範資料：品牌設定、人員與登入', () => {
  it('品牌 AI 風格各不相同（稱呼、版本開關）', () => {
    const styles = new Map(
      all<{ brand_id: number; addressing: string; variants: string; forbidden_promises: string; emoji_usage: string; signature: string }>(
        db,
        'SELECT * FROM brand_styles',
      ).map((s) => [s.brand_id, s]),
    );
    const style = (code: string) => styles.get(brandIdByCode.get(code)!)!;
    expect(style('CLEAR').addressing).toBe('您');
    expect(style('DAILY').addressing).toBe('你');
    expect(style('MORI').addressing).toBe('爸爸媽媽');
    for (const code of ['CLEAR', 'DAILY', 'MORI']) {
      const variants = parseJson<Array<{ key: string; enabled: boolean }>>(style(code).variants, []);
      expect(variants.map((v) => v.key)).toEqual(['friendly', 'concise', 'lively', 'professional']);
      expect(variants.find((v) => v.key === 'lively')!.enabled).toBe(code !== 'MORI');
      expect(parseJson<string[]>(style(code).forbidden_promises, []).length).toBeGreaterThanOrEqual(3);
      expect(style(code).signature.length).toBeGreaterThan(0);
    }
    expect(new Set(['CLEAR', 'DAILY', 'MORI'].map((c) => style(c).emoji_usage)).size).toBe(3);
  });

  it('品牌 × 留言類型設定：日日咖啡稱讚可 AI 自動回覆，小森客訴與負評維持人工', () => {
    const mode = (code: string, cat: string) =>
      get<{ handling_mode: string }>(
        db,
        `SELECT s.handling_mode FROM brand_category_settings s JOIN comment_categories c ON c.id = s.category_id
         WHERE s.brand_id = ? AND c.key = ?`,
        [brandIdByCode.get(code), cat],
      )!.handling_mode;
    expect(mode('DAILY', 'praise')).toBe('ai_auto');
    expect(mode('MORI', 'complaint')).toBe('manual');
    expect(mode('MORI', 'negative_review')).toBe('manual');
    expect(mode('CLEAR', 'praise')).toBe('ai_suggest');
  });

  it('示範帳號可用示範密碼登入，授權品牌與定義一致', async () => {
    for (const u of DEMO_USERS) {
      const row = get<{ id: number; password_hash: string; role: string; last_login_at: string | null }>(
        db,
        'SELECT id, password_hash, role, last_login_at FROM users WHERE email = ?',
        [u.email],
      )!;
      expect(verifyPassword(DEMO_PASSWORD, row.password_hash)).toBe(true);
      expect(row.role).toBe(u.role);
      expect(row.last_login_at).not.toBeNull();
      const brandIds = all<{ brand_id: number }>(db, 'SELECT brand_id FROM user_brands WHERE user_id = ? ORDER BY brand_id', [row.id]).map(
        (r) => r.brand_id,
      );
      expect(brandIds).toEqual(u.brandCodes.map((c) => brandIdByCode.get(c)!).sort((a, b) => a - b));
    }
    expect(DEMO_BRANDS.every((b) => brandIdByCode.has(b.code))).toBe(true);

    // 透過實際的登入 API（另開一個資料庫，避免登入紀錄影響其他測試）
    resetAllLoginFailures();
    const loginDb = openDb(':memory:');
    resetAndSeed(loginDb, { now: NOW });
    const app = createApp(loginDb, { serveStatic: false });
    for (const u of DEMO_USERS) {
      const res = await request(app).post('/api/auth/login').send({ email: u.email, password: DEMO_PASSWORD });
      expect(res.status, u.email).toBe(200);
    }
    loginDb.close();
  });

  it('schema_meta 記錄建立時間', () => {
    expect(get<{ value: string }>(db, "SELECT value FROM schema_meta WHERE key = 'seeded_at'")!.value).toBe(NOW.toISOString());
  });
});

describe('示範資料：可重現', () => {
  it('同一個 now 產生完全相同的資料', () => {
    const other = openDb(':memory:');
    resetAndSeed(other, { now: NOW });
    for (const table of ['comments', 'replies', 'assignments', 'comment_actions', 'audit_logs', 'posts', 'social_accounts', 'brand_styles', 'brand_category_settings']) {
      expect(all(other, `SELECT * FROM ${table} ORDER BY rowid`), table).toEqual(all(db, `SELECT * FROM ${table} ORDER BY rowid`));
    }
    other.close();
  });

  it('不同的 now 只會平移時間，留言內容與狀態相同', () => {
    const other = openDb(':memory:');
    const later = new Date(NOW_MS + 3 * 24 * 60 * MIN + 17 * MIN);
    resetAndSeed(other, { now: later });
    const a = all<{ body: string; status: string; occurred_at: string }>(other, 'SELECT body, status, occurred_at FROM comments ORDER BY id');
    const b = all<{ body: string; status: string; occurred_at: string }>(db, 'SELECT body, status, occurred_at FROM comments ORDER BY id');
    expect(a.map((r) => [r.body, r.status])).toEqual(b.map((r) => [r.body, r.status]));
    expect(a.map((r) => t(r.occurred_at) - later.getTime())).toEqual(b.map((r) => t(r.occurred_at) - NOW_MS));
    other.close();
  });

  it('重設會清掉舊資料（可重複執行）', () => {
    const again = resetAndSeed(db, { now: NOW });
    expect(again).toEqual(summary);
    expect(loadComments(db)).toEqual(comments);
  });
});
