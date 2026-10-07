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
