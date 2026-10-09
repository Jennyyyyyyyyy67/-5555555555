// API 請求／回應的資料型別（前後端共用）。欄位一律 camelCase，時間一律 ISO 8601 字串（UTC）。
import type {
  AccountStatus,
  Capability,
  CommentStatus,
  ContentType,
  HandlingMode,
  Priority,
  RiskFlag,
  RiskLevel,
  Role,
  Sentiment,
  Visibility,
} from './constants';

/** 錯誤回應格式：HTTP 4xx/5xx 時回傳 */
export interface ApiErrorBody {
  error: {
    code: string;
    /** 可直接顯示給使用者的繁體中文訊息 */
    message: string;
    details?: unknown;
  };
}

// ---------- 登入與身分 ----------
export interface SessionUser {
  id: number;
  name: string;
  email: string;
  role: Role;
}

export interface BrandSummary {
  id: number;
  name: string;
  code: string;
  color: string;
  isActive: boolean;
}

export interface MeResponse {
  user: SessionUser;
  /** 目前使用者可存取的品牌（管理員為全部品牌，含已停用；其他角色只含授權且啟用中的品牌） */
  brands: BrandSummary[];
}

export interface DemoAccount {
  email: string;
  password: string;
  name: string;
  role: Role;
  brandNames: string[];
}

export interface DemoAccountsResponse {
  enabled: boolean;
  accounts: DemoAccount[];
}

// ---------- 系統中繼資料 ----------
/** 帳號類型的 API 支援哪些動作（欄位清單與中文標籤見 constants.ts 的 CAPABILITIES / CAPABILITY_LABELS） */
export type PlatformCapabilities = Record<Capability, boolean>;

export interface AccountTypeMeta {
  key: string;
  label: string;
  contentTypes: ContentType[];
  capabilities: PlatformCapabilities;
}

export interface PlatformMeta {
  key: string;
  label: string;
  /** true 表示目前使用模擬 adapter（尚未串接真實 API） */
  isMock: boolean;
  accountTypes: AccountTypeMeta[];
}

export interface CategoryMeta {
  id: number;
  key: string;
  name: string;
  description: string;
  slaMinutes: number | null;
  defaultPriority: Priority;
  needsReply: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface MetaResponse {
  platforms: PlatformMeta[];
  categories: CategoryMeta[];
}

// ---------- 品牌 ----------
export interface Brand {
  id: number;
  name: string;
  code: string;
  color: string;
  description: string;
  nearDueMinutes: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** 以下統計只在管理員的列表中提供 */
  accountCount?: number;
  userCount?: number;
  commentCount?: number;
}

export interface BrandInput {
  name: string;
  code: string;
  color: string;
  description?: string;
  nearDueMinutes?: number;
}

export type BrandPatch = Partial<BrandInput> & { isActive?: boolean };

// ---------- 社群帳號 ----------
export interface SocialAccount {
  id: number;
  brandId: number;
  brandName: string;
  platform: string;
  accountType: string;
  name: string;
  handle: string;
  externalId: string;
  adapterKey: string;
  status: AccountStatus;
  isActive: boolean;
  lastCheckedAt: string | null;
  lastSyncedAt: string | null;
  postCount: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SocialAccountInput {
  brandId: number;
  platform: string;
  accountType: string;
  name: string;
  handle?: string;
  externalId: string;
}

/** 帳號建立後不可更換品牌與平台，避免品牌資料混在一起 */
export type SocialAccountPatch = Partial<Pick<SocialAccountInput, 'name' | 'handle'>> & { isActive?: boolean };

export interface ConnectionTestResult {
  ok: boolean;
  /** adapter 回傳的說明（繁體中文） */
  message: string;
}

export interface TestConnectionResponse extends ConnectionTestResult {
  account: SocialAccount;
}

/** POST /api/accounts 的回應：帳號資料 + 建立後立即執行的連線測試結果 */
export type CreateSocialAccountResponse = SocialAccount & { connection: ConnectionTestResult };

// ---------- 人員 ----------
export interface UserRow {
  id: number;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  /** 授權品牌；管理員固定為空陣列（代表全部品牌） */
  brandIds: number[];
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserInput {
  name: string;
  email: string;
  role: Role;
  password: string;
  brandIds: number[];
}

export type UserPatch = Partial<Pick<UserInput, 'name' | 'role' | 'brandIds'>> & { isActive?: boolean };

/** GET /api/users/directory?brand= 的項目：指派負責人、@提及用，只含最少欄位 */
export interface UserDirectoryEntry {
  id: number;
  name: string;
  role: Role;
}

// ---------- 留言（階段 1 預覽用；階段 2 起擴充） ----------
export interface CommentPreview {
  id: number;
  brandId: number;
  brandName: string;
  brandColor: string;
  platform: string;
  accountId: number;
  accountName: string;
  accountType: string;
  postId: number;
  postTitle: string;
  contentType: ContentType;
  isAd: boolean;
  parentCommentId: number | null;
  authorName: string;
  body: string;
  rating: number | null;
  occurredAt: string;
  fetchedAt: string;
  status: CommentStatus;
  priority: Priority | null;
  categoryKey: string | null;
  categoryName: string | null;
  tags: string[];
  riskFlags: RiskFlag[];
  riskLevel: RiskLevel | null;
  sentiment: Sentiment | null;
  handlingMode: HandlingMode | null;
  assigneeId: number | null;
  assigneeName: string | null;
  slaDueAt: string | null;
  firstResponseAt: string | null;
  completedAt: string | null;
  visibility: Visibility;
  /** 由 AI 自動處理（自動回覆或自動按讚結案） */
  isAutoHandled: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// ---------- 模擬資料 ----------
export interface MockStatsResponse {
  seededAt: string | null;
  totals: {
    brands: number;
    users: number;
    accounts: number;
    posts: number;
    comments: number;
    replies: number;
    auditLogs: number;
  };
  byBrand: Array<{
    brandId: number;
    brandName: string;
    brandColor: string;
    accounts: number;
    posts: number;
    comments: number;
    byPlatform: Record<string, number>;
    byStatus: Partial<Record<CommentStatus, number>>;
  }>;
}

/** 建立示範資料後的各表筆數 */
export interface SeedSummary {
  brands: number;
  users: number;
  accounts: number;
  posts: number;
  comments: number;
  replies: number;
  assignments: number;
  actions: number;
  auditLogs: number;
}

/** POST /api/mock/reset 的回應。me 為 null 代表目前登入的帳號不在新的示範資料中，已被登出。 */
export interface MockResetResponse {
  summary: SeedSummary;
  me: MeResponse | null;
}

export interface AuditLogEntry {
  id: number;
  brandId: number | null;
  brandName: string | null;
  commentId: number | null;
  actorType: 'user' | 'ai' | 'rule' | 'system';
  actorUserId: number | null;
  actorName: string | null;
  ruleId: number | null;
  action: string;
  targetType: string | null;
  targetId: number | null;
  summary: string;
  before: unknown;
  after: unknown;
  detail: unknown;
  createdAt: string;
}

// ======================================================================
// 階段 2：統一收件匣
// ======================================================================

/** 收件匣分頁 */
export const INBOX_TABS = ['todo', 'mine', 'unassigned', 'waiting', 'follow_up', 'closed', 'all'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];
export const INBOX_TAB_LABELS: Record<InboxTab, string> = {
  todo: '待處理',
  mine: '我的',
  unassigned: '未指派',
  waiting: '等待對方',
  follow_up: '稍後追蹤',
  closed: '已結束',
  all: '全部',
};

/** 收件匣列表的一則留言 */
export interface InboxItem extends CommentPreview {
  slaMinutes: number | null;
  /** 品牌設定的「即將超時」門檻（分鐘） */
  nearDueMinutes: number;
  needsHuman: boolean;
  isAutoHandled: boolean;
  isLiked: boolean;
  likeCount: number;
  handledById: number | null;
  handledByName: string | null;
  lockedById: number | null;
  lockedByName: string | null;
  lockExpiresAt: string | null;
  followUpAt: string | null;
  followUpNote: string;
  replyCount: number;
  /** 同一串中的其他留言數（不含品牌回覆） */
  threadCount: number;
}

export interface InboxResponse extends Paginated<InboxItem> {
  /** 伺服器目前時間，前端用來校正倒數 */
  serverTime: string;
  /** 各分頁筆數（依目前品牌範圍，不套用其他篩選） */
  tabCounts: Record<InboxTab, number>;
  /** 目前品牌範圍內：已超時、即將超時的數量 */
  overdue: number;
  nearDue: number;
}

export type ThreadEntry =
  | {
      kind: 'comment';
      id: number;
      parentId: number | null;
      authorName: string;
      body: string;
      rating: number | null;
      occurredAt: string;
      status: CommentStatus;
      visibility: Visibility;
      isCurrent: boolean;
    }
  | {
      kind: 'reply';
      id: number;
      commentId: number;
      body: string;
      sentAt: string;
      senderName: string | null;
      source: string;
    };

export interface ReplyEntry {
  id: number;
  body: string;
  source: string;
  sentAt: string;
  senderId: number | null;
  senderName: string | null;
  statusAfter: CommentStatus | null;
  deliveryStatus: 'sent' | 'failed';
}

export interface AssignmentEntry {
  id: number;
  fromName: string | null;
  toName: string | null;
  byName: string | null;
  reason: string;
  createdAt: string;
}

export interface NoteEntry {
  id: number;
  userId: number;
  userName: string;
  body: string;
  mentions: number[];
  createdAt: string;
}

export interface ActionEntry {
  id: number;
  action: string;
  reason: string;
  requestedByName: string | null;
  confirmedByName: string | null;
  result: 'success' | 'failed';
  createdAt: string;
}

export interface CommentLock {
  byId: number;
  byName: string;
  expiresAt: string;
  isMine: boolean;
}

export interface CommentDetail {
  comment: InboxItem & {
    originalAssigneeId: number | null;
    originalAssigneeName: string | null;
    firstResponseType: 'human' | 'ai_auto' | null;
    firstResponseByName: string | null;
    authorExternalId: string;
  };
  post: {
    id: number;
    title: string;
    body: string;
    url: string;
    contentType: ContentType;
    isAd: boolean;
    adCampaign: string | null;
    publishedAt: string;
  };
  account: {
    id: number;
    name: string;
    handle: string;
    platform: string;
    accountType: string;
    capabilities: PlatformCapabilities;
  };
  thread: ThreadEntry[];
  replies: ReplyEntry[];
  assignments: AssignmentEntry[];
  notes: NoteEntry[];
  actions: ActionEntry[];
  history: AuditLogEntry[];
  lock: CommentLock | null;
  /** 可指派、可 @ 的人員（有此品牌權限且啟用中） */
  directory: UserDirectoryEntry[];
  permissions: {
    /** 可回覆、變更狀態、執行互動動作（沒有被別人鎖定） */
    canHandle: boolean;
    /** 可重新指派給任何人（主管、管理員） */
    canReassign: boolean;
    /** 可強制接手別人的處理中鎖定 */
    canOverrideLock: boolean;
  };
  serverTime: string;
}

export interface ReplyInput {
  body: string;
  /** 回覆後的狀態：等待對方（還需要對方回應）或已完成 */
  statusAfter: 'waiting' | 'done';
}

export interface NotificationItem {
  id: number;
  type: string;
  message: string;
  commentId: number | null;
  brandId: number | null;
  isRead: boolean;
  createdAt: string;
}

export interface NotificationsResponse {
  items: NotificationItem[];
  unread: number;
}

// ---------- 留言類型與時效設定 ----------
export interface CategoryInput {
  name: string;
  description?: string;
  defaultSlaMinutes: number | null;
  defaultPriority: Priority;
  needsReply: boolean;
}
export type CategoryPatch = Partial<CategoryInput> & { isActive?: boolean };

export interface BrandCategorySetting {
  categoryId: number;
  key: string;
  name: string;
  categoryActive: boolean;
  defaultSlaMinutes: number | null;
  slaMinutes: number | null;
  slaEnabled: boolean;
  handlingMode: HandlingMode;
}

// ---------- 模擬器 ----------
export interface SimulateCommentInput {
  postId: number;
  /** 回覆某則留言（模擬對方追問）；不填則為新留言 */
  parentCommentId?: number | null;
  authorName: string;
  body: string;
  /** 階段 3 之前由模擬器指定分類（之後由 AI 判斷） */
  categoryKey: string;
  priority?: Priority;
  rating?: number | null;
  /** 幾分鐘前發生（預設 0，可模擬已等待一段時間的留言） */
  minutesAgo?: number;
}

// ---------- 自動回覆 ----------
export type AutomationAction = 'auto_reply' | 'auto_like';

export interface AutomationRule {
  id: number;
  brandId: number;
  brandName: string;
  name: string;
  description: string;
  action: AutomationAction;
  categories: string[];
  platforms: string[];
  minConfidence: number;
  isActive: boolean;
  sortOrder: number;
  /** 近 7 天實際觸發次數 */
  firedLast7Days: number;
  updatedAt: string;
  updatedByName: string | null;
}

export interface AutomationRuleInput {
  brandId: number;
  name: string;
  description?: string;
  action: AutomationAction;
  categories: string[];
  platforms: string[];
  minConfidence: number;
  isActive: boolean;
}
export type AutomationRulePatch = Partial<Omit<AutomationRuleInput, 'brandId'>>;

export interface AutomationMeta {
  /** 可設定自動回覆的類型（低風險、不需事實知識） */
  autoReplyCategories: string[];
  /** 可設定自動按讚的類型 */
  autoLikeCategories: string[];
  minConfidenceFloor: number;
  /** 強制轉人工條件（不可關閉） */
  forceHumanRules: Array<{ code: string; label: string }>;
}

export interface AutomationRulesResponse {
  rules: AutomationRule[];
  meta: AutomationMeta;
}

export interface AnalysisView {
  categoryKey: string;
  categoryName: string;
  tags: string[];
  riskFlags: RiskFlag[];
  riskLevel: RiskLevel;
  sentiment: Sentiment;
  priority: Priority;
  confidence: number;
  isAmbiguous: boolean;
  isMultiIssue: boolean;
  reasons: string[];
}

export interface AutomationDecision {
  analysis: AnalysisView;
  forceHuman: Array<{ code: string; label: string }>;
  matchedRule: { ruleId: number; ruleName: string; action: AutomationAction } | null;
  decision: 'auto_replied' | 'auto_liked' | 'human';
  explanation: string;
  replyBody: string | null;
}

export interface AutomationTestInput {
  brandId: number;
  platform: string;
  body: string;
  rating?: number | null;
}

export interface SimulatePostOption {
  id: number;
  title: string;
  contentType: ContentType;
  isAd: boolean;
  brandId: number;
  brandName: string;
  accountId: number;
  accountName: string;
  platform: string;
}

export interface SimulateResult extends AutomationDecision {
  commentId: number;
  slaMinutes: number | null;
  slaDueAt: string | null;
}

export interface AutomationRecentItem {
  id: number;
  action: string;
  summary: string;
  createdAt: string;
  commentId: number | null;
  brandName: string;
  commentBody: string | null;
  authorName: string | null;
  replyBody: string | null;
  forceHuman: string[];
}
