// 示範資料的「劇本」格式。各品牌的資料檔（clear.ts、daily.ts、mori.ts）只描述「發生了什麼事」，
// 實際寫入資料庫（時間計算、時效、狀態欄位、操作紀錄…）由 ../demoData.ts 的引擎負責。
//
// 時間一律用「距離現在幾分鐘」表示（ago），引擎會以重設資料當下的時間往前推算，
// 所以不論何時重設，系統看起來都像「此刻」的工作台。
import type {
  AccountStatus,
  ContentType,
  HandlingMode,
  Priority,
  RiskFlag,
  RiskLevel,
  Sentiment,
} from '../../../shared/constants';

/** 1 小時、1 天（分鐘） */
export const H = 60;
export const D = 24 * H;

/** 示範人員代號（取自 DEMO_USERS 的 email 帳號名稱） */
export type UserKey = 'admin' | 'lead' | 'amy' | 'hao';

/** 系統預設的 16 種留言類型 key（shared/constants.ts 的 DEFAULT_CATEGORIES） */
export type CategoryKey =
  | 'general'
  | 'praise'
  | 'product_inquiry'
  | 'price_inquiry'
  | 'purchase_inquiry'
  | 'usage'
  | 'after_sales'
  | 'complaint'
  | 'negative_review'
  | 'business_coop'
  | 'bulk_purchase'
  | 'opportunity'
  | 'spam'
  | 'malicious'
  | 'no_reply'
  | 'other';

export interface AccountSeed {
  key: string;
  platform: 'facebook' | 'instagram' | 'youtube' | 'google';
  accountType: 'fb_page' | 'fb_group' | 'ig_account' | 'yt_channel' | 'google_business';
  name: string;
  handle?: string;
  externalId: string;
  status?: AccountStatus;
  /** 最後同步時間（幾分鐘前），預設 2 分鐘前 */
  syncedAgo?: number;
  /** 最後測試連線時間（幾分鐘前），預設與 syncedAgo 相同 */
  checkedAgo?: number;
}

export interface PostSeed {
  key: string;
  /** AccountSeed.key */
  account: string;
  type: ContentType;
  /** 廣告活動名稱（type 為 ad 時必填） */
  campaign?: string;
  title: string;
  body: string;
  /** 發布時間（幾分鐘前） */
  ago: number;
}

/**
 * 留言的處理經過（最後狀態由此決定）：
 * - pending：尚未處理（可已指派）
 * - in_progress：某人正在處理（鎖定中）
 * - transferred：指派給 A 後，A 轉交給 B
 * - waiting / done：某人回覆（waiting＝等待對方，例如請對方私訊訂單編號）
 * - no_action：標記無需處理（可同時隱藏、刪除或按讚）
 *
 * at：事件發生在留言後第幾分鐘；省略時由引擎在時效內隨機決定（late=true 則刻意超過時效）。
 */
export type Flow =
  | { s: 'pending'; assign?: UserKey }
  | { s: 'in_progress'; lockBy: UserKey; lockAgo: number; assign?: UserKey }
  | { s: 'transferred'; assign: UserKey; to: UserKey; at: number; reason: string }
  | { s: 'waiting' | 'done'; by: UserKey; reply: string; at?: number; late?: boolean; assign?: UserKey; like?: boolean }
  | { s: 'no_action'; by: UserKey; at?: number; hide?: string; del?: string; like?: boolean };

export interface CommentSeed {
  /** 在品牌劇本內的代號，供回覆串（parent）引用 */
  key?: string;
  /** PostSeed.key */
  post: string;
  /** 回覆哪一則留言（CommentSeed.key）；必須在同一篇貼文 */
  parent?: string;
  /**
   * 留言者針對品牌回覆的追問（例如私訊後回來說「已私訊」）。
   * parent 必須是 waiting；引擎會把 parent 改為已完成（completed_at＝這則追問的時間），
   * 並寫入系統操作紀錄 comment.follow_up_received。這則追問本身是一則新的留言，有自己的時效。
   */
  followUp?: boolean;
  /** 留言者名稱（同平台同名視為同一人，author_external_id 相同） */
  by: string;
  /** 留言時間（幾分鐘前） */
  ago: number;
  text: string;
  cat: CategoryKey;
  tags?: string[];
  risk?: RiskFlag[];
  /** 省略時依風險標記推算 */
  level?: RiskLevel;
  /** 省略時依留言類型推算 */
  mood?: Sentiment;
  /** 省略時依類型預設＋風險＋互動熱度推算 */
  prio?: Priority;
  /** Google 評論星等（僅 Google 商家評論） */
  stars?: number;
  likes?: number;
  /** 省略時為 pending */
  flow?: Flow;
}

export interface BrandScript {
  /** DEMO_BRANDS 的品牌代碼 */
  code: string;
  /** 負責分派案件的人（主管或管理員） */
  assigner: UserKey;
  accounts: AccountSeed[];
  posts: PostSeed[];
  comments: CommentSeed[];
}

// ---------------- 品牌設定 ----------------
export interface BrandStyleSeed {
  personality: string;
  speakingStyle: string;
  tone: string;
  formality: number;
  humor: number;
  replyLength: 'short' | 'medium' | 'long';
  emojiUsage: 'none' | 'light' | 'frequent';
  addressing: string;
  commonPhrases: string[];
  bannedWords: string[];
  unsuitableTones: string[];
  forbiddenPromises: string[];
  signature: string;
  /** 停用的回覆版本（friendly / concise / lively / professional） */
  disabledVariants?: string[];
}

export interface CategoryTweak {
  category: CategoryKey;
  /** null 代表此品牌不計算這類留言的時效 */
  slaMinutes?: number | null;
  handlingMode?: HandlingMode;
  toneNote?: string;
  extraKeywords?: string[];
}

export interface BrandSettingsSeed {
  style: BrandStyleSeed;
  categories: CategoryTweak[];
}

// ---------------- 處理經過的簡寫 ----------------
export const pending = (assign?: UserKey): Flow => ({ s: 'pending', assign });

export const working = (lockBy: UserKey, lockAgo: number, assign?: UserKey): Flow => ({
  s: 'in_progress',
  lockBy,
  lockAgo,
  assign,
});

export const transferred = (assign: UserKey, to: UserKey, at: number, reason: string): Flow => ({
  s: 'transferred',
  assign,
  to,
  at,
  reason,
});

type ReplyOpts = { at?: number; late?: boolean; assign?: UserKey; like?: boolean };

export const waiting = (by: UserKey, reply: string, opts: ReplyOpts = {}): Flow => ({ s: 'waiting', by, reply, ...opts });

export const done = (by: UserKey, reply: string, opts: ReplyOpts = {}): Flow => ({ s: 'done', by, reply, ...opts });

export const noAction = (by: UserKey, opts: { at?: number; hide?: string; del?: string; like?: boolean } = {}): Flow => ({
  s: 'no_action',
  by,
  ...opts,
});
