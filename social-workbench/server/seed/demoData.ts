// 示範資料引擎：把 ./data/ 的品牌劇本寫入資料庫，讓系統看起來像品牌團隊「此刻」的工作台。
//
// 原則：
// - 結果完全由 opts.now 與固定亂數種子決定（同一個 now → 同樣的資料），不使用 Math.random 或 new Date()。
// - 所有時間都由 now 往前推算；歷史操作（指派、轉交、回覆、狀態變更、隱藏、刪除、按讚）都留下
//   當時時間的操作紀錄，資料彼此一致（時效、負責人、品牌權限、平台能力）。
// - 劇本有矛盾（例如回覆時間晚於現在、指派給沒有品牌權限的人）時直接丟出錯誤，避免產生不一致的示範資料。
import type { DB } from '../db';
import { all, get, insert, parseJson, run } from '../db';
import { ensureBrandDefaults } from '../db/bootstrap';
import { hashPassword } from '../auth/password';
import { adapterKeyFor, getAccountType } from '../adapters/registry';
import type { AccountTypeDef } from '../adapters/types';
import { audit, type AuditEntry } from '../services/audit';
import {
  LOCK_TTL_MINUTES,
  PRIORITIES,
  PRIORITY_RANK,
  STATUS_LABELS,
  type CommentStatus,
  type ContentType,
  type HandlingMode,
  type Priority,
  type RiskFlag,
  type RiskLevel,
  type Sentiment,
  type Visibility,
} from '../../shared/constants';
import { DEMO_BRANDS, DEMO_PASSWORD, DEMO_USERS } from './demo';
import { BRAND_SCRIPTS, BRAND_SETTINGS, LAST_LOGIN_AGO } from './data';
import type { AccountSeed, BrandScript, CommentSeed, Flow, PostSeed, UserKey } from './data/types';
import type { SeedSummary } from '../../shared/types';

// 回應型別放在 shared/types.ts（POST /api/mock/reset 會回傳）
export type { SeedSummary };

export function seedDemoData(db: DB, opts: { now: Date }): SeedSummary {
  return new DemoSeeder(db, opts.now).run();
}

// ---------------------------------------------------------------------------

const MIN = 60_000;
const DAY_MIN = 24 * 60;
const RANDOM_SEED = 20261007;

/** 這些風險一律需要人工處理 */
const FORCE_HUMAN_FLAGS: RiskFlag[] = [
  'complaint',
  'refund',
  'compensation',
  'sensitive',
  'safety',
  'unverifiable_promise',
  'legal',
  'public_dispute',
];
/** 出現即提高為高優先 */
const HIGH_PRIORITY_FLAGS: RiskFlag[] = ['complaint', 'refund', 'compensation', 'safety', 'legal', 'public_dispute'];
/** 出現時至少中優先 */
const MEDIUM_PRIORITY_FLAGS: RiskFlag[] = ['sensitive', 'unverifiable_promise', 'privacy', 'malicious'];
/** 出現即為高風險 */
const HIGH_RISK_FLAGS: RiskFlag[] = ['safety', 'legal', 'compensation'];
/** 熱門留言門檻（按讚數），會讓優先度提高一級 */
const POPULAR_LIKES = 30;

/** mulberry32：小而穩定的種子亂數產生器 */
class Rng {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }
  float(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** lo～hi（含）之間的整數 */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }
}

/** 穩定的短雜湊（FNV-1a），用來產生固定的外部 id */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0');
}

function fail(message: string): never {
  throw new Error(`示範資料劇本錯誤：${message}`);
}

interface UserInfo {
  key: UserKey;
  id: number;
  name: string;
  isAdmin: boolean;
  brandIds: Set<number>;
}

interface BrandInfo {
  id: number;
  code: string;
  name: string;
  script: BrandScript;
}

interface AccountInfo {
  id: number;
  seed: AccountSeed;
  type: AccountTypeDef;
}

interface PostInfo {
  id: number;
  seed: PostSeed;
  account: AccountInfo;
  publishedAt: number;
}

interface CategoryInfo {
  id: number;
  key: string;
  defaultPriority: Priority;
}

interface SettingInfo {
  slaMinutes: number | null;
  handlingMode: HandlingMode;
}

type HistoryEvent =
  | { t: 'assign'; at: number; by: UserInfo; to: UserInfo }
  | { t: 'transfer'; at: number; by: UserInfo; from: UserInfo; to: UserInfo; reason: string }
  | { t: 'lock'; at: number; by: UserInfo; expires: number; assignee: UserInfo | null }
  | { t: 'reply'; at: number; by: UserInfo; body: string; after: CommentStatus; assignee: UserInfo | null }
  | { t: 'status'; at: number; by: UserInfo; after: CommentStatus; assignee: UserInfo | null }
  | { t: 'action'; at: number; by: UserInfo; action: 'like' | 'hide' | 'delete'; reason: string; assignee: UserInfo | null };

/** 一則留言在寫入資料庫前的完整狀態 */
interface Draft {
  seed: CommentSeed;
  order: number;
  brand: BrandInfo;
  post: PostInfo;
  category: CategoryInfo;
  setting: SettingInfo;
  parent: Draft | null;
  root: Draft | null;
  occurred: number;
  fetched: number;
  likeCount: number;
  externalId: string;
  authorExternalId: string;
  status: CommentStatus;
  assignee: UserInfo | null;
  originalAssignee: UserInfo | null;
  handledBy: UserInfo | null;
  lockBy: UserInfo | null;
  lockedAt: number | null;
  lockExpires: number | null;
  firstResponseAt: number | null;
  firstResponseBy: UserInfo | null;
  completedAt: number | null;
  visibility: Visibility;
  isLiked: boolean;
  events: HistoryEvent[];
  /** 讓這則 waiting 留言結案的追問 */
  closedBy: Draft | null;
  id: number;
}

type PendingAudit = AuditEntry & { at: number; seq: number };

class DemoSeeder {
  private readonly rng = new Rng(RANDOM_SEED);
  private readonly nowMs: number;
  private readonly users = new Map<UserKey, UserInfo>();
  private readonly brands: BrandInfo[] = [];
  private readonly categories = new Map<string, CategoryInfo>();
  private readonly settings = new Map<string, SettingInfo>();
  private readonly audits: PendingAudit[] = [];

  constructor(
    private readonly db: DB,
    now: Date,
  ) {
    this.nowMs = now.getTime();
  }

  run(): SeedSummary {
    this.createBrands();
    this.createUsers();
    this.applyBrandSettings();
    this.loadCategories();

    const drafts: Draft[] = [];
    for (const brand of this.brands) {
      const accounts = this.createAccounts(brand);
      const posts = this.createPosts(brand, accounts);
      drafts.push(...this.draftComments(brand, posts, drafts.length));
    }
    for (const d of drafts) this.plan(d);
    this.applyFollowUps(drafts);

    // 依留言時間寫入，id 才會跟時間順序一致（被回覆的留言一定比較早，會先取得 id）
    drafts.sort((a, b) => a.occurred - b.occurred || a.order - b.order);
    for (const d of drafts) this.insertComment(d);
    for (const d of drafts) this.insertHistory(d);
    this.flushAudits();

    const nowIso = this.iso(this.nowMs);
    const summary = this.counts();
    audit(this.db, {
      actorType: 'system',
      action: 'mock.seed',
      targetType: 'system',
      summary: '建立示範資料',
      detail: { ...summary, auditLogs: undefined },
      createdAt: nowIso,
    });
    run(this.db, `INSERT INTO schema_meta (key, value) VALUES ('seeded_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [
      nowIso,
    ]);
    return this.counts();
  }

  // ---------------- 時間 ----------------
  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /** 幾分鐘前的時間（毫秒） */
  private ago(minutes: number): number {
    return this.nowMs - minutes * MIN;
  }

  // ---------------- 品牌、人員、設定 ----------------
  private createBrands(): void {
    DEMO_BRANDS.forEach((b, i) => {
      const script = BRAND_SCRIPTS.find((s) => s.code === b.code) ?? fail(`找不到品牌 ${b.code} 的劇本`);
      const createdAt = this.iso(this.ago((420 - i * 30) * DAY_MIN));
      const id = insert(this.db, 'brands', {
        name: b.name,
        code: b.code,
        color: b.color,
        description: b.description,
        created_at: createdAt,
        updated_at: createdAt,
      });
      ensureBrandDefaults(this.db, id);
      this.brands.push({ id, code: b.code, name: b.name, script });
    });
  }

  private createUsers(): void {
    const passwordHash = hashPassword(DEMO_PASSWORD);
    const createdAt = this.iso(this.ago(200 * DAY_MIN));
    for (const u of DEMO_USERS) {
      const key = u.email.split('@')[0] as UserKey;
      if (!(key in LAST_LOGIN_AGO)) fail(`示範人員 ${u.email} 沒有對應的代號`);
      const id = insert(this.db, 'users', {
        name: u.name,
        email: u.email,
        password_hash: passwordHash,
        role: u.role,
        is_active: 1,
        last_login_at: this.iso(this.ago(LAST_LOGIN_AGO[key])),
        created_at: createdAt,
        updated_at: createdAt,
      });
      const brandIds = new Set<number>();
      for (const code of u.brandCodes) {
        const brand = this.brands.find((b) => b.code === code) ?? fail(`示範人員 ${u.name} 的品牌 ${code} 不存在`);
        run(this.db, 'INSERT INTO user_brands (user_id, brand_id, created_at) VALUES (?, ?, ?)', [id, brand.id, createdAt]);
        brandIds.add(brand.id);
      }
      this.users.set(key, { key, id, name: u.name, isAdmin: u.role === 'admin', brandIds });
    }
  }

  /** 取得人員並確認他有該品牌的權限 */
  private userFor(key: UserKey, brand: BrandInfo): UserInfo {
    const user = this.users.get(key) ?? fail(`找不到示範人員 ${key}`);
    if (!user.isAdmin && !user.brandIds.has(brand.id)) fail(`${user.name} 沒有「${brand.name}」的權限，不能處理這個品牌的留言`);
    return user;
  }

  private adminUser(): UserInfo {
    return [...this.users.values()].find((u) => u.isAdmin) ?? fail('缺少管理員');
  }

  private applyBrandSettings(): void {
    const admin = this.adminUser();
    const updatedAt = this.iso(this.ago(30 * DAY_MIN));
    for (const brand of this.brands) {
      const s = BRAND_SETTINGS[brand.code] ?? fail(`找不到品牌 ${brand.code} 的設定`);
      // ensureBrandDefaults 以實際時間建立，這裡改成固定時間，確保同一個 now 產生相同資料
      run(this.db, 'UPDATE brand_category_settings SET updated_at = ? WHERE brand_id = ?', [updatedAt, brand.id]);

      for (const tweak of s.categories) {
        const cat = get<{ id: number }>(this.db, 'SELECT id FROM comment_categories WHERE key = ?', [tweak.category]);
        if (!cat) fail(`留言類型 ${tweak.category} 不存在`);
        const patch: Record<string, unknown> = { updated_by_id: admin.id };
        if (tweak.slaMinutes !== undefined) {
          patch.sla_minutes = tweak.slaMinutes;
          patch.sla_enabled = tweak.slaMinutes !== null;
        }
        if (tweak.handlingMode) patch.handling_mode = tweak.handlingMode;
        if (tweak.toneNote !== undefined) patch.tone_note = tweak.toneNote;
        if (tweak.extraKeywords) patch.extra_keywords = tweak.extraKeywords;
        const cols = Object.keys(patch);
        run(
          this.db,
          `UPDATE brand_category_settings SET ${cols.map((c) => `${c} = :${c}`).join(', ')}
           WHERE brand_id = :brand_id AND category_id = :category_id`,
          { ...patch, brand_id: brand.id, category_id: cat.id },
        );
      }

      const st = s.style;
      const row = get<{ variants: string }>(this.db, 'SELECT variants FROM brand_styles WHERE brand_id = ?', [brand.id]);
      const variants = parseJson<Array<{ key: string; label: string; enabled: boolean }>>(row?.variants, []).map((v) => ({
        ...v,
        enabled: !(st.disabledVariants ?? []).includes(v.key),
      }));
      run(
        this.db,
        `UPDATE brand_styles SET personality = :personality, speaking_style = :speaking_style, tone = :tone,
           formality = :formality, humor = :humor, reply_length = :reply_length, emoji_usage = :emoji_usage,
           addressing = :addressing, common_phrases = :common_phrases, banned_words = :banned_words,
           unsuitable_tones = :unsuitable_tones, forbidden_promises = :forbidden_promises, signature = :signature,
           variants = :variants, updated_by_id = :updated_by_id, updated_at = :updated_at
         WHERE brand_id = :brand_id`,
        {
          personality: st.personality,
          speaking_style: st.speakingStyle,
          tone: st.tone,
          formality: st.formality,
          humor: st.humor,
          reply_length: st.replyLength,
          emoji_usage: st.emojiUsage,
          addressing: st.addressing,
          common_phrases: st.commonPhrases,
          banned_words: st.bannedWords,
          unsuitable_tones: st.unsuitableTones,
          forbidden_promises: st.forbiddenPromises,
          signature: st.signature,
          variants,
          updated_by_id: admin.id,
          updated_at: updatedAt,
          brand_id: brand.id,
        },
      );
    }
  }

  private loadCategories(): void {
    for (const c of all<{ id: number; key: string; default_priority: Priority }>(
      this.db,
      'SELECT id, key, default_priority FROM comment_categories',
    )) {
      this.categories.set(c.key, { id: c.id, key: c.key, defaultPriority: c.default_priority });
    }
    for (const s of all<{ brand_id: number; key: string; sla_minutes: number | null; sla_enabled: number; handling_mode: HandlingMode }>(
      this.db,
      `SELECT s.brand_id, c.key, s.sla_minutes, s.sla_enabled, s.handling_mode
       FROM brand_category_settings s JOIN comment_categories c ON c.id = s.category_id`,
    )) {
      this.settings.set(`${s.brand_id}:${s.key}`, {
        slaMinutes: s.sla_enabled === 1 ? s.sla_minutes : null,
        handlingMode: s.handling_mode,
      });
    }
  }

  // ---------------- 社群帳號與貼文 ----------------
  private createAccounts(brand: BrandInfo): Map<string, AccountInfo> {
    const map = new Map<string, AccountInfo>();
    const createdAt = this.iso(this.ago(300 * DAY_MIN));
    for (const a of brand.script.accounts) {
      if (map.has(a.key)) fail(`${brand.code} 的帳號代號 ${a.key} 重複`);
      const type = getAccountType(a.platform, a.accountType) ?? fail(`${a.platform} 不支援帳號類型 ${a.accountType}`);
      const syncedAgo = a.syncedAgo ?? 2;
      const id = insert(this.db, 'social_accounts', {
        brand_id: brand.id,
        platform: a.platform,
        account_type: a.accountType,
        name: a.name,
        handle: a.handle ?? '',
        external_id: a.externalId,
        adapter_key: adapterKeyFor(a.platform),
        status: a.status ?? 'connected',
        is_active: 1,
        last_checked_at: this.iso(this.ago(a.checkedAgo ?? syncedAgo)),
        last_synced_at: this.iso(this.ago(syncedAgo)),
        created_at: createdAt,
        updated_at: createdAt,
      });
      map.set(a.key, { id, seed: a, type });
    }
    return map;
  }

  private createPosts(brand: BrandInfo, accounts: Map<string, AccountInfo>): Map<string, PostInfo> {
    const map = new Map<string, PostInfo>();
    for (const p of brand.script.posts) {
      if (map.has(p.key)) fail(`${brand.code} 的貼文代號 ${p.key} 重複`);
      const account = accounts.get(p.account) ?? fail(`貼文 ${p.key} 的帳號 ${p.account} 不存在`);
      if (!account.type.contentTypes.includes(p.type)) fail(`${account.seed.name} 不支援內容類型 ${p.type}`);
      if ((p.type === 'ad') !== Boolean(p.campaign)) fail(`貼文 ${p.key}：只有廣告需要（也必須）填寫廣告活動`);
      const code = hash(`${brand.code}:${p.key}`);
      const externalId = p.type === 'business_profile' ? `${account.seed.externalId}/profile` : `${account.seed.externalId}_${code}`;
      const publishedAt = this.ago(p.ago);
      const id = insert(this.db, 'posts', {
        brand_id: brand.id,
        social_account_id: account.id,
        external_id: externalId,
        content_type: p.type,
        is_ad: p.type === 'ad',
        ad_campaign: p.campaign ?? null,
        title: p.title,
        body: p.body,
        url: postUrl(account.seed, p.type, code),
        published_at: this.iso(publishedAt),
        created_at: this.iso(publishedAt),
      });
      map.set(p.key, { id, seed: p, account, publishedAt });
    }
    for (const account of accounts.values()) {
      if (account.seed.platform !== 'google') continue;
      const profiles = [...map.values()].filter((p) => p.account === account);
      if (profiles.length !== 1) fail(`${account.seed.name} 必須剛好有一個商家檔案`);
    }
    return map;
  }

  // ---------------- 留言草稿 ----------------
  private draftComments(brand: BrandInfo, posts: Map<string, PostInfo>, orderBase: number): Draft[] {
    const byKey = new Map<string, Draft>();
    const out: Draft[] = [];
    brand.script.comments.forEach((c, i) => {
      const label = `${brand.code}「${c.text.slice(0, 16)}」`;
      const post = posts.get(c.post) ?? fail(`${label} 的貼文 ${c.post} 不存在`);
      const category = this.categories.get(c.cat) ?? fail(`${label} 的留言類型 ${c.cat} 不存在`);
      const setting = this.settings.get(`${brand.id}:${c.cat}`) ?? fail(`${label} 缺少品牌類型設定`);
      const platform = post.account.seed.platform;
      const isGoogle = platform === 'google';
      if (isGoogle !== (c.stars !== undefined)) fail(`${label}：Google 評論必須有星等，其他平台不可有星等`);
      if (c.stars !== undefined && (c.stars < 1 || c.stars > 5)) fail(`${label} 的星等必須是 1～5`);
      if (c.ago < 1) fail(`${label} 的時間至少要在 1 分鐘前`);

      const occurred = this.ago(c.ago) - this.rng.int(0, 59) * 1000;
      if (occurred <= post.publishedAt) fail(`${label} 早於貼文發布時間`);
      // 系統取得時間：一般平台 1～3 分鐘，Google 評論 5～12 分鐘
      let fetchDelay = isGoogle ? this.rng.int(5, 12) : this.rng.int(1, 3);
      const explicitAt = c.flow && 'at' in c.flow ? c.flow.at : undefined;
      if (explicitAt !== undefined) {
        if (explicitAt < 3) fail(`${label} 的處理時間至少要在留言後 3 分鐘`);
        fetchDelay = Math.min(fetchDelay, explicitAt - 2);
      }
      fetchDelay = Math.min(fetchDelay, c.ago);

      const d: Draft = {
        seed: c,
        order: orderBase + i,
        brand,
        post,
        category,
        setting,
        parent: null,
        root: null,
        occurred,
        fetched: occurred + fetchDelay * MIN,
        likeCount: c.likes ?? this.randomLikes(),
        externalId: `${post.account.seed.externalId}_c${hash(`${brand.code}:${c.post}:${c.by}:${c.text}`)}`,
        authorExternalId: `${platform}-user-${hash(`${platform}:${c.by}`)}`,
        status: 'pending',
        assignee: null,
        originalAssignee: null,
        handledBy: null,
        lockBy: null,
        lockedAt: null,
        lockExpires: null,
        firstResponseAt: null,
        firstResponseBy: null,
        completedAt: null,
        visibility: 'visible',
        isLiked: false,
        events: [],
        closedBy: null,
        id: 0,
      };
      if (c.key) {
        if (byKey.has(c.key)) fail(`${brand.code} 的留言代號 ${c.key} 重複`);
        byKey.set(c.key, d);
      }
      out.push(d);
    });

    for (const d of out) {
      if (!d.seed.parent) {
        if (d.seed.followUp) fail(`${d.seed.by} 的追問必須指定 parent`);
        continue;
      }
      const p = byKey.get(d.seed.parent) ?? fail(`找不到被回覆的留言 ${d.seed.parent}`);
      if (p.post !== d.post) fail(`回覆必須與被回覆的留言在同一篇貼文（${d.seed.parent}）`);
      if (p.occurred >= d.occurred) fail(`回覆不可早於被回覆的留言（${d.seed.parent}）`);
      if (d.post.account.seed.platform === 'google') fail('Google 評論沒有留言串');
      d.parent = p;
      d.root = p.root ?? p;
    }
    return out;
  }

  /** 多數留言 0～5 個讚 */
  private randomLikes(): number {
    const r = this.rng.float();
    if (r < 0.55) return 0;
    if (r < 0.85) return this.rng.int(1, 2);
    return this.rng.int(3, 5);
  }

  // ---------------- 處理經過 ----------------
  private plan(d: Draft): void {
    const f: Flow = d.seed.flow ?? { s: 'pending' };
    const brand = d.brand;
    const label = `${brand.code}「${d.seed.text.slice(0, 16)}」`;
    const minutesSince = Math.floor((this.nowMs - d.occurred) / MIN);
    const fetchDelay = Math.round((d.fetched - d.occurred) / MIN);
    /** 留言後第 n 分鐘（加上幾秒，讓時間看起來自然） */
    const at = (n: number) => d.occurred + n * MIN + this.rng.int(5, 40) * 1000;
    const assertPast = (t: number) => {
      if (t > this.nowMs) fail(`${label} 的處理時間晚於現在`);
      if (t <= d.fetched) fail(`${label} 的處理時間早於系統取得留言的時間`);
    };

    let assignAt: number | null = null;
    if ('assign' in f && f.assign) {
      const to = this.userFor(f.assign, brand);
      assignAt = Math.min(d.fetched + MIN, this.nowMs);
      d.events.push({ t: 'assign', at: assignAt, by: this.userFor(brand.script.assigner, brand), to });
      d.assignee = d.originalAssignee = to;
    }
    const assigneeNow = d.assignee;

    switch (f.s) {
      case 'pending':
        d.status = 'pending';
        break;

      case 'in_progress': {
        const by = this.userFor(f.lockBy, brand);
        if (f.lockAgo < 0 || f.lockAgo >= LOCK_TTL_MINUTES) fail(`${label} 的鎖定必須在 ${LOCK_TTL_MINUTES} 分鐘內`);
        const lockedAt = this.ago(f.lockAgo) - this.rng.int(0, 30) * 1000;
        assertPast(lockedAt);
        if (assignAt !== null && assignAt >= lockedAt) fail(`${label} 的鎖定早於指派`);
        d.status = 'in_progress';
        d.lockBy = by;
        d.lockedAt = lockedAt;
        d.lockExpires = lockedAt + LOCK_TTL_MINUTES * MIN;
        d.events.push({ t: 'lock', at: lockedAt, by, expires: d.lockExpires, assignee: assigneeNow });
        break;
      }

      case 'transferred': {
        const from = assigneeNow ?? fail(`${label} 轉交前必須先指派`);
        const to = this.userFor(f.to, brand);
        const t = at(f.at);
        assertPast(t);
        if (assignAt !== null && t <= assignAt) fail(`${label} 的轉交早於指派`);
        d.events.push({ t: 'transfer', at: t, by: from, from, to, reason: f.reason });
        d.status = 'transferred';
        d.assignee = to;
        break;
      }

      case 'waiting':
      case 'done': {
        const by = this.userFor(f.by, brand);
        const minDelay = fetchDelay + (assignAt !== null ? 2 : 1);
        const delay = this.replyDelay(d, f, minDelay, minutesSince - 1, label);
        const t = at(delay);
        assertPast(t);
        d.events.push({ t: 'reply', at: t, by, body: f.reply, after: f.s, assignee: assigneeNow });
        d.status = f.s;
        d.firstResponseAt = t;
        d.firstResponseBy = by;
        d.handledBy = by;
        if (f.s === 'done') d.completedAt = t;
        if (f.like) this.addAction(d, by, 'like', '', t, label);
        break;
      }

      case 'no_action': {
        const by = this.userFor(f.by, brand);
        const lo = fetchDelay + 1;
        const hi = minutesSince - 1;
        const delay = f.at ?? (hi < lo ? fail(`${label} 太新，來不及標記無需處理`) : this.rng.int(lo, Math.min(lo + 40, hi)));
        const t = at(delay);
        assertPast(t);
        if (f.hide && f.del) fail(`${label} 不可同時隱藏與刪除`);
        if (f.hide) this.addAction(d, by, 'hide', f.hide, t, label);
        if (f.del) this.addAction(d, by, 'delete', f.del, t, label);
        if (f.like) this.addAction(d, by, 'like', '', t, label);
        d.events.push({ t: 'status', at: t, by, after: 'no_action', assignee: assigneeNow });
        d.status = 'no_action';
        d.completedAt = t;
        d.handledBy = by;
        d.visibility = f.del ? 'deleted' : f.hide ? 'hidden' : 'visible';
        break;
      }
    }
  }

  /** 首次回覆在留言後第幾分鐘：預設在時效內（偏向較快回覆），late 則刻意超過時效與 60 分鐘 */
  private replyDelay(d: Draft, f: { at?: number; late?: boolean }, lo: number, hi: number, label: string): number {
    const sla = d.setting.slaMinutes;
    let delay: number;
    if (f.at !== undefined) {
      delay = f.at;
    } else if (f.late) {
      delay = Math.max((sla ?? 30) + 8, 62) + this.rng.int(0, 50);
    } else {
      const top = Math.min((sla ?? 45) - 1, hi);
      if (top < lo) fail(`${label} 太新，來不及在時效內回覆`);
      const r = this.rng.float();
      delay = lo + Math.floor((top - lo + 1) * r * r);
    }
    if (delay < lo || delay > hi) fail(`${label} 的回覆時間（留言後 ${delay} 分鐘）不合理`);
    if (sla !== null && Boolean(f.late) !== delay >= sla) {
      fail(`${label} 的回覆時間與是否逾時（late）不一致`);
    }
    return delay;
  }

  private addAction(d: Draft, by: UserInfo, action: 'like' | 'hide' | 'delete', reason: string, t: number, label: string): void {
    if (!d.post.account.type.capabilities[action]) fail(`${label}：${d.post.account.seed.name} 不支援「${action}」`);
    if (action === 'delete' && !reason.trim()) fail(`${label}：刪除必須填寫理由`);
    d.events.push({ t: 'action', at: t, by, action, reason, assignee: d.assignee });
    if (action === 'like') d.isLiked = true;
  }

  /** 追問到達：原本 waiting 的留言改為已完成 */
  private applyFollowUps(drafts: Draft[]): void {
    for (const d of drafts) {
      if (!d.seed.followUp) continue;
      const p = d.parent!;
      const label = `${d.brand.code}「${d.seed.text.slice(0, 16)}」`;
      if (p.status !== 'waiting') fail(`${label} 是追問，但被回覆的留言不是「等待對方」`);
      if (p.seed.by !== d.seed.by) fail(`${label} 是追問，必須是同一位留言者`);
      if (p.firstResponseAt === null || p.firstResponseAt >= d.occurred) fail(`${label} 是追問，必須晚於品牌回覆`);
      p.closedBy = d;
      p.status = 'done';
      p.completedAt = d.occurred;
    }
  }

  // ---------------- 寫入 ----------------
  private priority(d: Draft): Priority {
    if (d.seed.prio) return d.seed.prio;
    const key = d.category.key;
    if (key === 'spam' || key === 'no_reply') return 'low';
    const flags = d.seed.risk ?? [];
    let rank = PRIORITY_RANK[d.category.defaultPriority];
    if (flags.some((f) => HIGH_PRIORITY_FLAGS.includes(f))) rank = 0;
    else if (flags.some((f) => MEDIUM_PRIORITY_FLAGS.includes(f))) rank = Math.min(rank, 1);
    if (d.likeCount >= POPULAR_LIKES) rank = Math.max(0, rank - 1);
    return PRIORITIES[rank];
  }

  private riskLevel(d: Draft): RiskLevel {
    if (d.seed.level) return d.seed.level;
    const flags = d.seed.risk ?? [];
    if (flags.length === 0) return 'none';
    if (flags.some((f) => HIGH_RISK_FLAGS.includes(f))) return 'high';
    if (flags.includes('complaint') && d.likeCount >= POPULAR_LIKES) return 'high';
    if (flags.every((f) => f === 'spam')) return 'low';
    return 'medium';
  }

  private sentiment(d: Draft): Sentiment {
    if (d.seed.mood) return d.seed.mood;
    if (d.category.key === 'praise') return 'positive';
    if (['complaint', 'negative_review', 'malicious'].includes(d.category.key)) return 'negative';
    return 'neutral';
  }

  private insertComment(d: Draft): void {
    const flags = d.seed.risk ?? [];
    const sla = d.setting.slaMinutes;
    const lastEvent = Math.max(d.fetched, d.completedAt ?? 0, ...d.events.map((e) => e.at));
    d.id = insert(this.db, 'comments', {
      brand_id: d.brand.id,
      social_account_id: d.post.account.id,
      post_id: d.post.id,
      parent_comment_id: d.parent?.id ?? null,
      thread_root_id: d.root?.id ?? null,
      external_id: d.externalId,
      author_name: d.seed.by,
      author_external_id: d.authorExternalId,
      body: d.seed.text,
      rating: d.seed.stars ?? null,
      like_count: d.likeCount,
      occurred_at: this.iso(d.occurred),
      fetched_at: this.iso(d.fetched),
      status: d.status,
      priority: this.priority(d),
      category_id: d.category.id,
      tags: d.seed.tags ?? [],
      risk_flags: flags,
      risk_level: this.riskLevel(d),
      sentiment: this.sentiment(d),
      handling_mode: d.setting.handlingMode,
      needs_human: flags.some((f) => FORCE_HUMAN_FLAGS.includes(f)),
      assignee_id: d.assignee?.id ?? null,
      original_assignee_id: d.originalAssignee?.id ?? null,
      handled_by_id: d.handledBy?.id ?? null,
      locked_by_id: d.lockBy?.id ?? null,
      locked_at: d.lockedAt === null ? null : this.iso(d.lockedAt),
      lock_expires_at: d.lockExpires === null ? null : this.iso(d.lockExpires),
      sla_minutes: sla,
      sla_due_at: sla === null ? null : this.iso(d.occurred + sla * MIN),
      first_response_at: d.firstResponseAt === null ? null : this.iso(d.firstResponseAt),
      first_response_type: d.firstResponseAt === null ? null : 'human',
      first_response_by_id: d.firstResponseBy?.id ?? null,
      completed_at: d.completedAt === null ? null : this.iso(d.completedAt),
      visibility: d.visibility,
      is_liked: d.isLiked,
      created_at: this.iso(d.fetched),
      updated_at: this.iso(lastEvent),
    });
  }

  private insertHistory(d: Draft): void {
    const base = { brandId: d.brand.id, commentId: d.id, targetType: 'comment', targetId: d.id };
    for (const ev of d.events) {
      const createdAt = this.iso(ev.at);
      switch (ev.t) {
        case 'assign': {
          const assignmentId = insert(this.db, 'assignments', {
            comment_id: d.id,
            brand_id: d.brand.id,
            from_user_id: null,
            to_user_id: ev.to.id,
            assigned_by_id: ev.by.id,
            reason: '',
            created_at: createdAt,
          });
          this.pushAudit(ev.at, {
            ...base,
            actorType: 'user',
            actorUserId: ev.by.id,
            action: 'comment.assign',
            assigneeIdAtTime: ev.to.id,
            summary: `${ev.by.name} 將留言指派給 ${ev.to.name}`,
            before: { assigneeId: null },
            after: { assigneeId: ev.to.id },
            detail: { assignmentId },
          });
          break;
        }
        case 'transfer': {
          const assignmentId = insert(this.db, 'assignments', {
            comment_id: d.id,
            brand_id: d.brand.id,
            from_user_id: ev.from.id,
            to_user_id: ev.to.id,
            assigned_by_id: ev.by.id,
            reason: ev.reason,
            created_at: createdAt,
          });
          this.pushAudit(ev.at, {
            ...base,
            actorType: 'user',
            actorUserId: ev.by.id,
            action: 'comment.transfer',
            assigneeIdAtTime: ev.from.id,
            summary: `${ev.by.name} 將留言轉交給 ${ev.to.name}`,
            before: { assigneeId: ev.from.id, status: 'pending' },
            after: { assigneeId: ev.to.id, status: 'transferred' },
            detail: { assignmentId, reason: ev.reason },
          });
          break;
        }
        case 'lock':
          this.pushAudit(ev.at, {
            ...base,
            actorType: 'user',
            actorUserId: ev.by.id,
            action: 'comment.status_change',
            assigneeIdAtTime: ev.assignee?.id ?? null,
            summary: `${ev.by.name} 開始處理留言`,
            before: { status: 'pending' },
            after: { status: 'in_progress' },
            detail: { lockExpiresAt: this.iso(ev.expires) },
          });
          break;
        case 'reply': {
          const platformReplyId = `mock-reply-${hash(`${d.externalId}:${ev.at}`)}`;
          const replyId = insert(this.db, 'replies', {
            comment_id: d.id,
            brand_id: d.brand.id,
            body: ev.body,
            source: 'manual',
            was_edited: 0,
            sent_by_id: ev.by.id,
            status_after: ev.after,
            platform_reply_id: platformReplyId,
            delivery_status: 'sent',
            sent_at: createdAt,
            created_at: createdAt,
          });
          this.pushAudit(ev.at, {
            ...base,
            actorType: 'user',
            actorUserId: ev.by.id,
            action: 'comment.reply',
            assigneeIdAtTime: ev.assignee?.id ?? null,
            summary: `${ev.by.name} 回覆留言，狀態改為「${STATUS_LABELS[ev.after]}」`,
            before: { status: 'pending' },
            after: { status: ev.after },
            detail: { replyId, source: 'manual', platformReplyId },
          });
          break;
        }
        case 'status':
          this.pushAudit(ev.at, {
            ...base,
            actorType: 'user',
            actorUserId: ev.by.id,
            action: 'comment.status_change',
            assigneeIdAtTime: ev.assignee?.id ?? null,
            summary: `${ev.by.name} 將留言標記為「${STATUS_LABELS[ev.after]}」`,
            before: { status: 'pending' },
            after: { status: ev.after },
          });
          break;
        case 'action': {
          const actionId = insert(this.db, 'comment_actions', {
            comment_id: d.id,
            brand_id: d.brand.id,
            action: ev.action,
            suggested_by: 'user',
            requested_by_id: ev.by.id,
            confirmed_by_id: ev.by.id,
            confirmed_at: createdAt,
            reason: ev.reason,
            result: 'success',
            created_at: createdAt,
          });
          const summary =
            ev.action === 'like'
              ? `${ev.by.name} 對留言按讚`
              : `${ev.by.name} ${ev.action === 'hide' ? '隱藏' : '刪除'}留言：${ev.reason}`;
          this.pushAudit(ev.at, {
            ...base,
            actorType: 'user',
            actorUserId: ev.by.id,
            action: `comment.${ev.action}`,
            assigneeIdAtTime: ev.assignee?.id ?? null,
            summary,
            detail: { actionId, reason: ev.reason || undefined, platform: d.post.account.seed.platform },
          });
          break;
        }
      }
    }
    if (d.closedBy) {
      const f = d.closedBy;
      this.pushAudit(f.fetched, {
        ...base,
        actorType: 'system',
        action: 'comment.follow_up_received',
        assigneeIdAtTime: d.assignee?.id ?? null,
        summary: `${f.seed.by} 已回覆追問，留言自動標記為「${STATUS_LABELS.done}」`,
        before: { status: 'waiting' },
        after: { status: 'done' },
        detail: { followUpCommentId: f.id },
      });
    }
  }

  private pushAudit(at: number, entry: AuditEntry): void {
    this.audits.push({ ...entry, createdAt: this.iso(at), at, seq: this.audits.length });
  }

  /** 依發生時間寫入操作紀錄，id 順序與時間一致 */
  private flushAudits(): void {
    this.audits.sort((a, b) => a.at - b.at || a.seq - b.seq);
    for (const { at: _at, seq: _seq, ...entry } of this.audits) audit(this.db, entry);
  }

  private counts(): SeedSummary {
    const n = (table: string) => get<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM ${table}`)!.n;
    return {
      brands: n('brands'),
      users: n('users'),
      accounts: n('social_accounts'),
      posts: n('posts'),
      comments: n('comments'),
      replies: n('replies'),
      assignments: n('assignments'),
      actions: n('comment_actions'),
      auditLogs: n('audit_logs'),
    };
  }
}

function postUrl(account: AccountSeed, type: ContentType, code: string): string {
  switch (account.accountType) {
    case 'fb_page':
      return `https://www.facebook.com/${account.handle || account.externalId}/posts/${code}`;
    case 'fb_group':
      return `https://www.facebook.com/groups/${account.externalId}/posts/${code}`;
    case 'ig_account':
      return type === 'reel' ? `https://www.instagram.com/reel/${code}/` : `https://www.instagram.com/p/${code}/`;
    case 'yt_channel':
      return type === 'short' ? `https://www.youtube.com/shorts/${code}` : `https://www.youtube.com/watch?v=${code}`;
    case 'google_business':
      return `https://www.google.com/maps/place/?q=place_id:${code}`;
  }
}
