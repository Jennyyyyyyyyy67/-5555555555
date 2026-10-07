// 前後端共用的列舉值與繁體中文標籤。
// 規則：資料庫與 API 一律存英文 key，畫面顯示時再查這裡的中文標籤。

export const ROLES = ['admin', 'supervisor', 'operator'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理員',
  supervisor: '主管',
  operator: '操作人員',
};
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: '管理整體系統、品牌、人員、規則與設定，可存取所有品牌。',
  supervisor: '管理負責品牌的案件、查看數據、調整指派並可介入處理。',
  operator: '處理自己被授權品牌的留言。',
};

// ---- 社群平台（實際可用的平台由後端 adapter registry 決定，這裡只放已知平台的標籤） ----
export const KNOWN_PLATFORMS = ['facebook', 'instagram', 'youtube', 'google'] as const;
export type KnownPlatform = (typeof KNOWN_PLATFORMS)[number];
export const PLATFORM_LABELS: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  youtube: 'YouTube',
  google: 'Google 商家',
};

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  fb_page: 'Facebook 粉絲專頁',
  fb_group: 'Facebook 社團',
  ig_account: 'Instagram 帳號',
  yt_channel: 'YouTube 頻道',
  google_business: 'Google 商家檔案',
};

export const ACCOUNT_STATUSES = ['connected', 'disconnected', 'error'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  connected: '已連線',
  disconnected: '未連線',
  error: '連線異常',
};

// 留言所在內容的型態
export const CONTENT_TYPES = ['post', 'ad', 'reel', 'video', 'short', 'group_post', 'business_profile'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  post: '貼文',
  ad: '廣告',
  reel: 'Reels',
  video: '影片',
  short: 'Shorts',
  group_post: '社團貼文',
  business_profile: '商家評論',
};

// ---- 留言處理狀態：「已回覆」不等於「已完成」 ----
export const COMMENT_STATUSES = ['pending', 'in_progress', 'waiting', 'transferred', 'no_action', 'done'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];
export const STATUS_LABELS: Record<CommentStatus, string> = {
  pending: '待處理',
  in_progress: '處理中',
  waiting: '等待對方',
  transferred: '已轉交',
  no_action: '無需處理',
  done: '已完成',
};
/** 仍屬「未結束」的狀態（會出現在待辦中） */
export const OPEN_STATUSES: CommentStatus[] = ['pending', 'in_progress', 'waiting', 'transferred'];
/** 仍需在時效內做首次回覆的狀態 */
export const SLA_ACTIVE_STATUSES: CommentStatus[] = ['pending', 'in_progress', 'transferred'];

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { high: '高', medium: '中', low: '低' };
export const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];
export const SENTIMENT_LABELS: Record<Sentiment, string> = { positive: '正面', neutral: '中性', negative: '負面' };

export const RISK_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = { none: '無', low: '低', medium: '中', high: '高' };

/** 風險標記（可多選） */
export const RISK_FLAGS = [
  'complaint',
  'refund',
  'compensation',
  'sensitive',
  'safety',
  'legal',
  'unverifiable_promise',
  'public_dispute',
  'malicious',
  'spam',
  'privacy',
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];
export const RISK_FLAG_LABELS: Record<RiskFlag, string> = {
  complaint: '客訴',
  refund: '退款',
  compensation: '補償',
  sensitive: '敏感議題',
  safety: '安全疑慮',
  legal: '法律風險',
  unverifiable_promise: '無法確認的承諾',
  public_dispute: '公開爭議',
  malicious: '惡意內容',
  spam: '垃圾訊息',
  privacy: '個資',
};

// ---- AI 處理模式 ----
export const HANDLING_MODES = ['manual', 'ai_suggest', 'ai_auto'] as const;
export type HandlingMode = (typeof HANDLING_MODES)[number];
export const HANDLING_MODE_LABELS: Record<HandlingMode, string> = {
  manual: '人工處理',
  ai_suggest: 'AI 建議＋人工確認',
  ai_auto: 'AI 自動回覆',
};

// ---- 留言可見狀態 ----
export const VISIBILITIES = ['visible', 'hidden', 'deleted'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABELS: Record<Visibility, string> = { visible: '顯示中', hidden: '已隱藏', deleted: '已刪除' };

// ---- 社群互動動作 ----
export const INTERACTION_ACTIONS = ['like', 'unlike', 'hide', 'unhide', 'delete', 'block'] as const;
export type InteractionAction = (typeof INTERACTION_ACTIONS)[number];
export const INTERACTION_ACTION_LABELS: Record<InteractionAction, string> = {
  like: '按讚',
  unlike: '取消按讚',
  hide: '隱藏',
  unhide: '取消隱藏',
  delete: '刪除',
  block: '封鎖／限制',
};
/** 高風險動作：一律需要人工確認並填寫理由，自動化規則不可執行 */
export const HIGH_RISK_ACTIONS: InteractionAction[] = ['delete', 'block'];

// ---- 回覆來源 ----
export const REPLY_SOURCES = ['manual', 'ai_adopted', 'ai_edited', 'canned', 'auto_rule', 'batch'] as const;
export type ReplySource = (typeof REPLY_SOURCES)[number];
export const REPLY_SOURCE_LABELS: Record<ReplySource, string> = {
  manual: '人工撰寫',
  ai_adopted: '採用 AI 建議',
  ai_edited: '修改 AI 建議',
  canned: '標準回覆',
  auto_rule: 'AI 自動回覆',
  batch: '批次回覆',
};

// ---- 操作紀錄的執行者類型 ----
export const ACTOR_TYPES = ['user', 'ai', 'rule', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export const ACTOR_TYPE_LABELS: Record<ActorType, string> = {
  user: '人員',
  ai: 'AI',
  rule: '自動化規則',
  system: '系統',
};

// ---- 知識庫分類 ----
export const KNOWLEDGE_CATEGORIES = [
  'brand_intro',
  'product_info',
  'spec',
  'price',
  'faq',
  'usage',
  'installation',
  'warranty',
  'after_sales',
  'campaign',
  'other',
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];
export const KNOWLEDGE_CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  brand_intro: '品牌介紹',
  product_info: '產品資訊',
  spec: '商品規格',
  price: '價格資訊',
  faq: '常見問題',
  usage: '使用方式',
  installation: '安裝方式',
  warranty: '保固政策',
  after_sales: '售後規範',
  campaign: '活動資訊',
  other: '其他品牌知識',
};

// ---- 異常事件與洞察類型（階段 5 使用） ----
export const ANOMALY_TYPES = [
  'negative_spike',
  'product_issue_cluster',
  'comment_surge',
  'low_rating_increase',
  'repeated_question',
  'trending_topic',
  'business_opportunity',
  'high_engagement',
] as const;
export type AnomalyType = (typeof ANOMALY_TYPES)[number];
export const ANOMALY_TYPE_LABELS: Record<AnomalyType, string> = {
  negative_spike: '負面留言突然增加',
  product_issue_cluster: '產品問題大量出現',
  comment_surge: '內容突然湧入大量留言',
  low_rating_increase: 'Google 低星評論增加',
  repeated_question: '問題被大量重複詢問',
  trending_topic: '特定話題突然受到關注',
  business_opportunity: '出現潛在商業機會',
  high_engagement: '留言或討論特別受到關注',
};

export const INSIGHT_TYPES = [
  'hot_question',
  'hot_topic',
  'common_question',
  'common_complaint',
  'product_issue',
  'user_need',
  'purchase_barrier',
  'business_opportunity',
  'positive_feedback',
  'content_idea',
] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];
export const INSIGHT_TYPE_LABELS: Record<InsightType, string> = {
  hot_question: '熱門問題',
  hot_topic: '熱門話題',
  common_question: '顧客常見疑問',
  common_complaint: '常見抱怨',
  product_issue: '產品問題',
  user_need: '使用者需求',
  purchase_barrier: '購買阻力',
  business_opportunity: '潛在商機',
  positive_feedback: '品牌正面反饋',
  content_idea: '值得製作內容的主題',
};

// ---- 預設留言類型（系統初始化時建立；管理員之後可新增、停用、調整） ----
export interface DefaultCategory {
  key: string;
  name: string;
  description: string;
  /** 首次回覆時限（分鐘）；null 表示不列入時效計算 */
  slaMinutes: number | null;
  defaultPriority: Priority;
  /** 是否預期需要回覆 */
  needsReply: boolean;
  /** 預設處理模式（品牌可個別調整） */
  defaultMode: HandlingMode;
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { key: 'general', name: '一般互動', description: '打招呼、標記朋友、日常閒聊等一般互動', slaMinutes: 60, defaultPriority: 'low', needsReply: true, defaultMode: 'ai_suggest' },
  { key: 'praise', name: '稱讚', description: '對品牌、產品或服務的正面回饋', slaMinutes: 60, defaultPriority: 'low', needsReply: true, defaultMode: 'ai_suggest' },
  { key: 'product_inquiry', name: '產品詢問', description: '詢問產品功能、規格、差異', slaMinutes: 30, defaultPriority: 'medium', needsReply: true, defaultMode: 'ai_suggest' },
  { key: 'price_inquiry', name: '價格詢問', description: '詢問售價、優惠、方案', slaMinutes: 30, defaultPriority: 'medium', needsReply: true, defaultMode: 'ai_suggest' },
  { key: 'purchase_inquiry', name: '購買詢問', description: '詢問購買管道、門市、庫存、運送', slaMinutes: 30, defaultPriority: 'medium', needsReply: true, defaultMode: 'ai_suggest' },
  { key: 'usage', name: '使用方式', description: '詢問如何使用、安裝、保養', slaMinutes: 60, defaultPriority: 'medium', needsReply: true, defaultMode: 'ai_suggest' },
  { key: 'after_sales', name: '售後問題', description: '維修、保固、更換零件等售後需求', slaMinutes: 30, defaultPriority: 'medium', needsReply: true, defaultMode: 'ai_suggest' },
  { key: 'complaint', name: '客訴', description: '對產品或服務表達不滿並要求處理', slaMinutes: 15, defaultPriority: 'high', needsReply: true, defaultMode: 'manual' },
  { key: 'negative_review', name: '負面評論', description: '公開的負面評價或批評', slaMinutes: 30, defaultPriority: 'high', needsReply: true, defaultMode: 'manual' },
  { key: 'business_coop', name: '商業合作', description: '業配、聯名、通路、媒體等合作邀約', slaMinutes: 30, defaultPriority: 'medium', needsReply: true, defaultMode: 'ai_suggest' },
  { key: 'bulk_purchase', name: '大量採購', description: '企業採購、團購、大量訂購', slaMinutes: 30, defaultPriority: 'high', needsReply: true, defaultMode: 'ai_suggest' },
  { key: 'opportunity', name: '潛在商機', description: '可能轉換為銷售或合作的機會', slaMinutes: 30, defaultPriority: 'medium', needsReply: true, defaultMode: 'ai_suggest' },
  { key: 'spam', name: '垃圾訊息', description: '廣告、詐騙連結、洗版內容', slaMinutes: null, defaultPriority: 'low', needsReply: false, defaultMode: 'manual' },
  { key: 'malicious', name: '惡意留言', description: '人身攻擊、謾罵、惡意抹黑', slaMinutes: null, defaultPriority: 'medium', needsReply: false, defaultMode: 'manual' },
  { key: 'no_reply', name: '無需回覆', description: '單純貼圖、表情、標記朋友等不需回覆的留言', slaMinutes: null, defaultPriority: 'low', needsReply: false, defaultMode: 'manual' },
  { key: 'other', name: '其他', description: '無法歸類的留言', slaMinutes: 60, defaultPriority: 'low', needsReply: true, defaultMode: 'ai_suggest' },
];

/** 預設「即將超時」門檻（剩餘分鐘數），品牌可調整 */
export const DEFAULT_NEAR_DUE_MINUTES = 15;
/** 處理中鎖定的有效時間（分鐘），無動作即自動釋放 */
export const LOCK_TTL_MINUTES = 10;
