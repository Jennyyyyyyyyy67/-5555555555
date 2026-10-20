// API 請求／回應的資料型別（前後端共用）。欄位一律 camelCase，時間一律 ISO 8601 字串（UTC）。
import type {
  AccountStatus,
  Capability,
  CommentStatus,
  ContentType,
  HandlingMode,
  KnowledgeCategory,
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
  /** 可以透過登入連結真實帳號的帳號類型（其餘為示範／模擬） */
  liveAccountTypes: string[];
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
  /** 目前使用的 AI：claude（真正的 AI）或 mock（關鍵字規則） */
  ai: { provider: 'claude' | 'gemini' | 'mock'; model: string | null };
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
      /** 這則回覆是否已收錄為回覆範例（null 代表尚未收錄） */
      exampleStatus: ReplyExampleStatus | null;
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
  /** 最新一次 AI 判斷的細節 */
  ai: AiSummary | null;
  serverTime: string;
}

export interface ReplyInput {
  body: string;
  /** 回覆後的狀態：等待對方（還需要對方回應）或已完成 */
  statusAfter: 'waiting' | 'done';
  /** 採用（或修改自）哪一則 AI 建議 */
  suggestionId?: number | null;
  /** 使用哪一則標準回覆 */
  cannedReplyId?: number | null;
  /** 已看過送出前檢查的提醒，仍要送出 */
  confirmWarnings?: boolean;
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
  /** 品牌對這類留言的語氣與處理指引（AI 產生回覆時參考） */
  toneNote: string;
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
export type AutomationAction = 'auto_reply' | 'auto_like' | 'force_human';
export type RuleMatchType = 'category' | 'keyword';

export interface AutomationRule {
  id: number;
  brandId: number;
  brandName: string;
  name: string;
  description: string;
  action: AutomationAction;
  /** category：依 AI 判斷的留言類型；keyword：留言包含關鍵字時回覆固定內容 */
  matchType: RuleMatchType;
  categories: string[];
  keywords: string[];
  /** 關鍵字規則的回覆內容（{name} 會換成留言者名稱） */
  replyTemplate: string;
  platforms: string[];
  minConfidence: number;
  /** 轉人工規則：提升為高優先 */
  raisePriority: boolean;
  /** 轉人工規則：直接指派的負責人 */
  assigneeId: number | null;
  assigneeName: string | null;
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
  matchType?: RuleMatchType;
  categories: string[];
  keywords?: string[];
  replyTemplate?: string;
  platforms: string[];
  minConfidence: number;
  raisePriority?: boolean;
  assigneeId?: number | null;
  isActive: boolean;
}
export type AutomationRulePatch = Partial<Omit<AutomationRuleInput, 'brandId'>>;

export interface AutomationMeta {
  /** 可設定自動回覆的類型（低風險、不需事實知識） */
  autoReplyCategories: string[];
  /** 其中需要知識庫有答案才會自動回覆的類型 */
  knowledgeAutoCategories: string[];
  /** 可設定自動按讚的類型 */
  autoLikeCategories: string[];
  minConfidenceFloor: number;
  /** 關鍵字規則仍會擋下的強制轉人工條件（客訴、退款、敏感、承諾、風險） */
  keywordBlockingCodes: string[];
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

// ======================================================================
// 階段 3：AI 判斷、品牌風格、知識庫、回覆建議
// ======================================================================
export interface AiSummary {
  provider: string;
  analyzedAt: string;
  confidence: number | null;
  reasons: string[];
  forceHuman: Array<{ code: string; label: string }>;
  needsKnowledge: boolean;
  knowledgeGap: boolean;
  /** 人工修正過分類或優先級 */
  correctedByName: string | null;
  /** AI 原本判斷的類型（被修正時顯示） */
  originalCategoryName: string | null;
}

export interface ClassifyInput {
  categoryKey?: string;
  priority?: Priority;
  reason?: string;
}

export type KnowledgeStatus = 'approved' | 'pending' | 'rejected';

export interface KnowledgeItem {
  id: number;
  brandId: number;
  brandName: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  keywords: string[];
  isActive: boolean;
  validFrom: string | null;
  validTo: string | null;
  reviewStatus: KnowledgeStatus;
  source: 'manual' | 'from_reply' | 'import';
  sourceCommentId: number | null;
  version: number;
  createdByName: string | null;
  updatedByName: string | null;
  approvedByName: string | null;
  createdAt: string;
  updatedAt: string;
  /** 已超過有效期限 */
  isExpired: boolean;
  /** 尚未開始生效 */
  isUpcoming: boolean;
}

export interface KnowledgeInput {
  brandId: number;
  category: KnowledgeCategory;
  title: string;
  content: string;
  keywords: string[];
  validFrom?: string | null;
  validTo?: string | null;
  sourceCommentId?: number | null;
}
export type KnowledgePatch = Partial<Omit<KnowledgeInput, 'brandId' | 'sourceCommentId'>> & { note?: string };

export interface KnowledgeRevision {
  id: number;
  version: number;
  changeType: string;
  snapshot: { title: string; content: string; keywords: string[]; category: string; validFrom: string | null; validTo: string | null };
  note: string;
  changedByName: string | null;
  createdAt: string;
}

export interface KnowledgeListResponse {
  items: KnowledgeItem[];
  counts: { all: number; approved: number; pending: number; rejected: number; expired: number; inactive: number };
}

export interface KnowledgeDetailResponse {
  item: KnowledgeItem;
  revisions: KnowledgeRevision[];
}

export interface KnowledgeHit {
  id: number;
  title: string;
  category: KnowledgeCategory;
  content: string;
  /** 留言中命中的關鍵字 */
  matched: string[];
}

export interface KnowledgeSearchResult {
  categoryKey: string;
  categoryName: string;
  needsKnowledge: boolean;
  hits: KnowledgeHit[];
  /** 符合但已過期（或尚未生效）而沒有使用的知識 */
  skipped: Array<{ id: number; title: string; reason: string }>;
}

export interface StyleVariant {
  key: string;
  label: string;
  enabled: boolean;
}

export interface BrandStyleView {
  brandId: number;
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
  variants: StyleVariant[];
  updatedAt: string;
  updatedByName: string | null;
}
export type BrandStyleInput = Omit<BrandStyleView, 'brandId' | 'updatedAt' | 'updatedByName'>;

export interface ReplyWarning {
  /** block：必須修改才能送出；confirm：確認後可送出 */
  level: 'block' | 'confirm';
  code: string;
  message: string;
}

export interface SuggestionVariant {
  /** 儲存後的建議 id（預覽時為 null） */
  id: number | null;
  key: string;
  label: string;
  body: string;
  knowledgeIds: number[];
  warnings: ReplyWarning[];
}

export interface SuggestionSet {
  round: number;
  createdAt: string;
  requestedByName: string | null;
  categoryKey: string;
  categoryName: string;
  needsKnowledge: boolean;
  knowledgeGap: boolean;
  hits: KnowledgeHit[];
  skipped: KnowledgeSearchResult['skipped'];
  forceHuman: Array<{ code: string; label: string }>;
  /** 品牌對這類留言的處理指引 */
  guidance: string;
  forbiddenPromises: string[];
  variants: SuggestionVariant[];
  /** 給小編的提醒（例如：知識不足、已略過活潑版） */
  notes: string[];
  /** 這類留言的品牌回覆範例（AI 也會參考） */
  examples: ReplyExample[];
}

export interface SuggestionsResponse {
  latest: SuggestionSet | null;
}

export interface ReplyCheckResult {
  warnings: ReplyWarning[];
}

export interface StylePreviewInput {
  body: string;
  style: BrandStyleInput;
}

// ---------- 真實平台串接 ----------
export interface InstagramStatus {
  /** 已設定 INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET */
  configured: boolean;
  /** 要填到 Meta 後台「OAuth 重新導向 URI」的網址 */
  redirectUri: string;
  /** 要填到 Meta 後台 Webhook 的回呼網址 */
  webhookUrl: string;
  webhookConfigured: boolean;
  accounts: Array<{
    accountId: number;
    username: string;
    brandName: string;
    tokenExpiresAt: string | null;
    connectedAt: string;
    lastSyncedAt: string | null;
    status: string;
  }>;
}

export interface SyncResult {
  ok: boolean;
  message: string;
  newPosts: number;
  newComments: number;
  autoReplied: number;
}

// ---------- 企業自助註冊 ----------
export interface SignupInput {
  companyName: string;
  name: string;
  email: string;
  password: string;
}

export interface AuthConfigResponse {
  signupEnabled: boolean;
  demoMode: boolean;
}

// ---------- 階段 4：相似留言分組與批次處理 ----------
export interface GroupComment {
  id: number;
  authorName: string;
  body: string;
  occurredAt: string;
  status: CommentStatus;
  priority: Priority | null;
  slaDueAt: string | null;
  firstResponseAt: string | null;
  categoryName: string | null;
  assigneeName: string | null;
  /** 別人正在處理（鎖定中） */
  lockedByName: string | null;
}

export interface CommentGroup {
  key: string;
  intentKey: string;
  label: string;
  /** false：只能批次標記（例如垃圾訊息），不批次回覆 */
  replyable: boolean;
  brandId: number;
  brandName: string;
  brandColor: string;
  postId: number;
  postTitle: string;
  contentType: ContentType;
  isAd: boolean;
  platform: string;
  accountName: string;
  /** 組內最早到期的時效 */
  earliestDueAt: string | null;
  comments: GroupComment[];
}

export interface CommentGroupsResponse {
  groups: CommentGroup[];
  /** 需要個別處理、沒有放進任何組的待處理留言數（客訴、退款、敏感、風險等） */
  individualCount: number;
  serverTime: string;
}

export interface BatchSuggestInput {
  commentIds: number[];
  /** 回覆版本（親切、簡潔…）；預設品牌第一個啟用的版本 */
  variantKey?: string;
}

export interface BatchDraft {
  commentId: number;
  authorName: string;
  commentBody: string;
  suggestionId: number;
  body: string;
  warnings: ReplyWarning[];
}

export interface BatchSuggestResponse {
  batchId: string;
  variantKey: string;
  variants: Array<{ key: string; label: string }>;
  knowledgeGap: boolean;
  hits: KnowledgeHit[];
  notes: string[];
  drafts: BatchDraft[];
  /** 無法放進這批的留言與原因 */
  skipped: Array<{ commentId: number; reason: string }>;
}

export interface BatchReplyInput {
  batchId?: string;
  statusAfter: 'waiting' | 'done';
  confirmWarnings?: boolean;
  items: Array<{ commentId: number; body: string; suggestionId?: number | null }>;
}

export interface BatchItemResult {
  commentId: number;
  ok: boolean;
  error?: string;
}

export interface BatchResult {
  batchId: string;
  results: BatchItemResult[];
  succeeded: number;
  failed: number;
}

export interface BatchStatusInput {
  commentIds: number[];
  status: 'no_action' | 'done';
  reason?: string;
}

// ---------- 階段 5：數據看板、異常事件、社群洞察、報表、操作紀錄 ----------
export interface DateRange {
  /** YYYY-MM-DD（台灣時間，含當天） */
  from: string;
  to: string;
}

export interface CountItem {
  key: string;
  label: string;
  count: number;
}

export interface OpsMetrics {
  total: number;
  today: number;
  /** 範圍內留言目前的狀態分布 */
  pending: number;
  inProgress: number;
  waiting: number;
  transferred: number;
  done: number;
  noAction: number;
  /** 目前（不限範圍）即將超時、已超時的待回覆留言 */
  nearDue: number;
  overdue: number;
  /** 平均首次回覆時間（分鐘） */
  avgFirstResponseMinutes: number | null;
  /** 依各類型時效計算的達成率 */
  slaMetRate: number | null;
  /** 60 分鐘內首次回覆的比例（需要回覆的留言） */
  within60Rate: number | null;
  needReply: number;
}

export interface AiMetrics {
  suggestions: number;
  humanReplies: number;
  /** 人工回覆中採用（含修改）AI 建議的比例 */
  adoptionRate: number | null;
  /** 採用 AI 建議時有修改的比例 */
  editRate: number | null;
  autoReplied: number;
  autoRate: number | null;
  forcedHuman: number;
  knowledgeGap: number;
}

export interface DailyPoint {
  date: string;
  total: number;
  positive: number;
  neutral: number;
  negative: number;
  firstResponses: number;
  autoReplied: number;
}

export interface PostVolume {
  postId: number;
  title: string;
  platform: string;
  brandName: string;
  isAd: boolean;
  count: number;
  negative: number;
}

export interface CommunityMetrics {
  byPlatform: Array<CountItem & { negative: number }>;
  byBrand: Array<CountItem & { negative: number; color: string }>;
  topPosts: PostVolume[];
  topAds: PostVolume[];
  byCategory: CountItem[];
  sentiment: { positive: number; neutral: number; negative: number };
  complaints: number;
  opportunities: number;
  hotTopics: CountItem[];
  commonQuestions: CountItem[];
}

export interface TeamMemberMetrics {
  userId: number;
  name: string;
  role: Role;
  replies: number;
  /** 處理過的留言數（回覆或結案） */
  handled: number;
  firstResponses: number;
  avgFirstResponseMinutes: number | null;
  /** 首次回覆超過時效的比例 */
  lateRate: number | null;
  aiUseRate: number | null;
  topCategories: CountItem[];
}

export interface DashboardResponse {
  range: DateRange;
  brandIds: number[];
  ops: OpsMetrics;
  ai: AiMetrics;
  community: CommunityMetrics;
  team: TeamMemberMetrics[];
  daily: DailyPoint[];
  serverTime: string;
}

export type AnomalyType =
  | 'negative_spike'
  | 'product_issue'
  | 'post_burst'
  | 'low_rating'
  | 'repeated_question'
  | 'hot_topic'
  | 'opportunity'
  | 'hot_thread';

export interface AnomalyExample {
  commentId: number;
  authorName: string;
  body: string;
  occurredAt: string;
}

export interface AnomalyEvent {
  key: string;
  type: AnomalyType;
  typeLabel: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  brandId: number;
  brandName: string;
  detectedAt: string;
  current: number;
  baseline: number | null;
  postId: number | null;
  link: string;
  examples: AnomalyExample[];
  ack: { userName: string; note: string; createdAt: string } | null;
}

export interface AnomaliesResponse {
  events: AnomalyEvent[];
  serverTime: string;
}

export interface InsightExample {
  commentId: number;
  authorName: string;
  body: string;
  brandName: string;
  platform: string;
}

export interface InsightItem {
  label: string;
  count: number;
  examples: InsightExample[];
}

export interface InsightSection {
  key: string;
  title: string;
  description: string;
  items: InsightItem[];
}

export interface InsightsResponse {
  range: DateRange;
  totalComments: number;
  sections: InsightSection[];
}

export interface ComparisonRow {
  key: string;
  label: string;
  total: number;
  negative: number;
  complaints: number;
  avgFirstResponseMinutes: number | null;
  slaMetRate: number | null;
  autoRate: number | null;
  adoptionRate: number | null;
}

export interface ReportResponse {
  range: DateRange;
  previous: DateRange;
  ops: OpsMetrics;
  ai: AiMetrics;
  previousOps: OpsMetrics;
  previousAi: AiMetrics;
  community: CommunityMetrics;
  daily: DailyPoint[];
  brands: ComparisonRow[];
  platforms: ComparisonRow[];
  anomalies: AnomalyEvent[];
  insights: InsightSection[];
  /** 自動整理的重點摘要 */
  highlights: string[];
  generatedAt: string;
}

export interface AuditQueryResponse {
  items: Array<AuditLogEntry & { replyBody?: string | null; aiOriginalBody?: string | null; replySource?: string | null }>;
  total: number;
  page: number;
  pageSize: number;
}

// ---------- 標準回覆與回覆範例 ----------
export interface CannedReply {
  id: number;
  brandId: number;
  brandName: string;
  categoryId: number | null;
  categoryName: string | null;
  title: string;
  body: string;
  isActive: boolean;
  createdByName: string | null;
  updatedAt: string;
}

export interface CannedReplyInput {
  brandId: number;
  categoryId: number | null;
  title: string;
  body: string;
}

export type ReplyExampleStatus = 'active' | 'pending' | 'rejected' | 'inactive';

export interface ReplyExample {
  id: number;
  brandId: number;
  brandName: string;
  categoryId: number | null;
  categoryName: string | null;
  scenario: string;
  sampleComment: string;
  goodReply: string;
  badReply: string;
  notes: string;
  status: ReplyExampleStatus;
  source: 'manual' | 'from_reply';
  sourceReplyId: number | null;
  submittedByName: string | null;
  approvedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReplyExampleInput {
  brandId: number;
  categoryId: number | null;
  scenario: string;
  sampleComment: string;
  goodReply: string;
  badReply: string;
  notes: string;
}

export interface ReplyExampleListResponse {
  items: ReplyExample[];
  counts: Record<ReplyExampleStatus | 'all', number>;
}

// ---------- AI 快速設定 ----------
/** 店家填寫的基本資料；事實類欄位（地址、時間、價格…）只會原樣整理成知識，不交給 AI 改寫 */
export interface SetupProfile {
  businessName: string;
  /** 行業，例如：美髮店、咖啡店 */
  industry: string;
  /** 店家特色、主要在做什麼 */
  description: string;
  /** 服務或商品（一行一項，或用頓號分隔） */
  services: string;
  /** 品牌形象與個性 */
  brandImage: string;
  /** 主要客群（選填） */
  audience: string;
  addressing: string;
  emojiUsage: 'none' | 'light' | 'frequent';
  signature: string;
  address: string;
  hours: string;
  booking: string;
  contact: string;
  prices: string;
  /** 其他事實，例如停車、付款方式（一行一項） */
  otherFacts: string;
  /** 不可承諾的事（一行一項） */
  forbiddenPromises: string;
}

export interface SetupKnowledgeDraft {
  category: KnowledgeCategory;
  title: string;
  content: string;
  keywords: string[];
  /** 品牌已有同名知識（加入時會略過） */
  exists: boolean;
}

export interface SetupCannedDraft {
  categoryId: number | null;
  categoryName: string | null;
  title: string;
  body: string;
  exists: boolean;
  /** 給店家確認的提醒（例如內容有店家資料裡沒有的數字） */
  warnings: string[];
}

export interface SetupExampleDraft {
  categoryId: number | null;
  categoryName: string | null;
  scenario: string;
  sampleComment: string;
  goodReply: string;
  badReply: string;
  notes: string;
  warnings: string[];
}

export interface SetupDraft {
  provider: 'claude' | 'gemini' | 'mock';
  style: BrandStyleInput;
  toneNotes: Array<{ categoryId: number; categoryName: string; note: string }>;
  knowledge: SetupKnowledgeDraft[];
  canned: SetupCannedDraft[];
  examples: SetupExampleDraft[];
  notes: string[];
}

export interface SetupApplyInput {
  style: BrandStyleInput | null;
  toneNotes: Array<{ categoryId: number; note: string }>;
  knowledge: Array<{ category: KnowledgeCategory; title: string; content: string; keywords: string[] }>;
  canned: Array<{ categoryId: number | null; title: string; body: string }>;
  examples: Array<{ categoryId: number | null; scenario: string; sampleComment: string; goodReply: string; badReply: string; notes: string }>;
}

export interface SetupApplyResult {
  style: boolean;
  toneNotes: number;
  knowledge: number;
  canned: number;
  examples: number;
  skipped: string[];
}
