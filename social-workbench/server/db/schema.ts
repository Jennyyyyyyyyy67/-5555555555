// 完整資料表結構（涵蓋階段 1～5）。
// 慣例：
// - 主鍵一律 INTEGER id；時間一律 ISO 8601 UTC 字串（TEXT）；布林以 0/1 存放；JSON 以 TEXT 存放。
// - 凡屬於某品牌的資料都帶 brand_id，所有查詢都必須依使用者可存取的品牌過濾。
// - 「平台」與「帳號類型」不用 CHECK 限制，由 adapter registry 驗證，方便日後新增平台。
// - 不可妥協的原則盡量在資料庫層也擋一次（例如：刪除／封鎖必須有人工確認者、操作紀錄只能新增）。

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ========== 帳號與權限 ==========
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','supervisor','operator')),
  is_active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#4f46e5',
  description TEXT NOT NULL DEFAULT '',
  near_due_minutes INTEGER NOT NULL DEFAULT 15 CHECK (near_due_minutes BETWEEN 1 AND 240),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 人員被授權的品牌（管理員不需要，預設可存取全部品牌）
CREATE TABLE IF NOT EXISTS user_brands (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, brand_id)
);

-- 登入狀態（只存 token 的雜湊值）
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ========== 社群帳號與內容 ==========
CREATE TABLE IF NOT EXISTS social_accounts (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  platform TEXT NOT NULL,
  account_type TEXT NOT NULL,
  name TEXT NOT NULL,
  handle TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL,
  adapter_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','disconnected','error')),
  is_active INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_accounts_brand ON social_accounts(brand_id);

-- 原始貼文／廣告／影片／商家頁面
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id),
  external_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('post','ad','reel','video','short','group_post','business_profile')),
  is_ad INTEGER NOT NULL DEFAULT 0,
  ad_campaign TEXT,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (social_account_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_posts_brand ON posts(brand_id);
CREATE INDEX IF NOT EXISTS idx_posts_account ON posts(social_account_id);

-- ========== 留言類型與品牌設定 ==========
CREATE TABLE IF NOT EXISTS comment_categories (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  default_sla_minutes INTEGER CHECK (default_sla_minutes IS NULL OR default_sla_minutes > 0),
  default_priority TEXT NOT NULL DEFAULT 'medium' CHECK (default_priority IN ('high','medium','low')),
  needs_reply INTEGER NOT NULL DEFAULT 1,
  default_mode TEXT NOT NULL DEFAULT 'ai_suggest' CHECK (default_mode IN ('manual','ai_suggest','ai_auto')),
  is_system INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 品牌 × 留言類型：回覆時效、處理模式、語氣調整、品牌專屬分類關鍵字
CREATE TABLE IF NOT EXISTS brand_category_settings (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES comment_categories(id) ON DELETE CASCADE,
  sla_minutes INTEGER CHECK (sla_minutes IS NULL OR sla_minutes > 0),
  sla_enabled INTEGER NOT NULL DEFAULT 1,
  handling_mode TEXT NOT NULL DEFAULT 'ai_suggest' CHECK (handling_mode IN ('manual','ai_suggest','ai_auto')),
  tone_note TEXT NOT NULL DEFAULT '',
  extra_keywords TEXT NOT NULL DEFAULT '[]',
  is_enabled INTEGER NOT NULL DEFAULT 1,
  updated_by_id INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (brand_id, category_id)
);

-- ========== 相似留言分組與批次（階段 4） ==========
CREATE TABLE IF NOT EXISTS comment_groups (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  post_id INTEGER REFERENCES posts(id),
  topic_key TEXT NOT NULL,
  label TEXT NOT NULL,
  representative_comment_id INTEGER,
  comment_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','processed','dismissed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_brand ON comment_groups(brand_id, status);

CREATE TABLE IF NOT EXISTS batch_jobs (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  group_id INTEGER REFERENCES comment_groups(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  comment_ids TEXT NOT NULL DEFAULT '[]',
  params TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- ========== 留言 ==========
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id),
  post_id INTEGER NOT NULL REFERENCES posts(id),
  parent_comment_id INTEGER REFERENCES comments(id),
  thread_root_id INTEGER REFERENCES comments(id),
  external_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_external_id TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  like_count INTEGER NOT NULL DEFAULT 0,
  -- 時間紀錄：留言發生、系統取得、首次回覆、最終完成
  occurred_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  -- 處理狀態
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','waiting','transferred','no_action','done')),
  priority TEXT CHECK (priority IS NULL OR priority IN ('high','medium','low')),
  -- AI 判斷結果（最新一次）
  category_id INTEGER REFERENCES comment_categories(id),
  tags TEXT NOT NULL DEFAULT '[]',
  risk_flags TEXT NOT NULL DEFAULT '[]',
  risk_level TEXT CHECK (risk_level IS NULL OR risk_level IN ('none','low','medium','high')),
  sentiment TEXT CHECK (sentiment IS NULL OR sentiment IN ('positive','neutral','negative')),
  handling_mode TEXT CHECK (handling_mode IS NULL OR handling_mode IN ('manual','ai_suggest','ai_auto')),
  latest_analysis_id INTEGER,
  knowledge_gap INTEGER NOT NULL DEFAULT 0,
  needs_human INTEGER NOT NULL DEFAULT 0,
  is_auto_handled INTEGER NOT NULL DEFAULT 0,
  -- 人員：目前負責人、原始負責人、實際處理人
  assignee_id INTEGER REFERENCES users(id),
  original_assignee_id INTEGER REFERENCES users(id),
  handled_by_id INTEGER REFERENCES users(id),
  -- 處理中鎖定（避免多人重複處理）
  locked_by_id INTEGER REFERENCES users(id),
  locked_at TEXT,
  lock_expires_at TEXT,
  -- 回覆時效
  sla_minutes INTEGER,
  sla_due_at TEXT,
  first_response_at TEXT,
  first_response_type TEXT CHECK (first_response_type IS NULL OR first_response_type IN ('human','ai_auto')),
  first_response_by_id INTEGER REFERENCES users(id),
  completed_at TEXT,
  -- 稍後追蹤
  follow_up_at TEXT,
  follow_up_note TEXT NOT NULL DEFAULT '',
  group_id INTEGER REFERENCES comment_groups(id),
  visibility TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','hidden','deleted')),
  is_liked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (social_account_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_comments_brand_status ON comments(brand_id, status);
CREATE INDEX IF NOT EXISTS idx_comments_sla ON comments(sla_due_at);
CREATE INDEX IF NOT EXISTS idx_comments_assignee ON comments(assignee_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_root_id);
CREATE INDEX IF NOT EXISTS idx_comments_occurred ON comments(occurred_at);

-- 轉交／指派紀錄（保留原負責人與每次轉交）
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  comment_id INTEGER NOT NULL REFERENCES comments(id),
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  from_user_id INTEGER REFERENCES users(id),
  to_user_id INTEGER REFERENCES users(id),
  assigned_by_id INTEGER REFERENCES users(id),
  rule_id INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignments_comment ON assignments(comment_id);

-- 內部備註與 @ 提及
CREATE TABLE IF NOT EXISTS internal_notes (
  id INTEGER PRIMARY KEY,
  comment_id INTEGER NOT NULL REFERENCES comments(id),
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_comment ON internal_notes(comment_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id),
  type TEXT NOT NULL,
  comment_id INTEGER REFERENCES comments(id),
  ref_type TEXT,
  ref_id INTEGER,
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- ========== AI ==========
CREATE TABLE IF NOT EXISTS ai_analyses (
  id INTEGER PRIMARY KEY,
  comment_id INTEGER NOT NULL REFERENCES comments(id),
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  category_key TEXT,
  category_id INTEGER REFERENCES comment_categories(id),
  tags TEXT NOT NULL DEFAULT '[]',
  risk_flags TEXT NOT NULL DEFAULT '[]',
  risk_level TEXT,
  sentiment TEXT,
  priority TEXT,
  priority_reasons TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  is_ambiguous INTEGER NOT NULL DEFAULT 0,
  is_multi_issue INTEGER NOT NULL DEFAULT 0,
  knowledge_hits TEXT NOT NULL DEFAULT '[]',
  knowledge_gap INTEGER NOT NULL DEFAULT 0,
  force_human_reasons TEXT NOT NULL DEFAULT '[]',
  recommended_mode TEXT,
  final_mode TEXT,
  suggested_action TEXT,
  suggested_action_reason TEXT NOT NULL DEFAULT '',
  raw TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_comment ON ai_analyses(comment_id);

-- AI 回覆建議原文（保留原始內容，供比對人工是否修改）
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id INTEGER PRIMARY KEY,
  comment_id INTEGER NOT NULL REFERENCES comments(id),
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  analysis_id INTEGER REFERENCES ai_analyses(id),
  variant_key TEXT NOT NULL,
  variant_label TEXT NOT NULL,
  body TEXT NOT NULL,
  knowledge_ids TEXT NOT NULL DEFAULT '[]',
  example_ids TEXT NOT NULL DEFAULT '[]',
  batch_job_id INTEGER REFERENCES batch_jobs(id),
  generation_round INTEGER NOT NULL DEFAULT 1,
  is_adopted INTEGER NOT NULL DEFAULT 0,
  requested_by_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestions_comment ON ai_suggestions(comment_id);

-- 品牌 AI 回覆風格
CREATE TABLE IF NOT EXISTS brand_styles (
  brand_id INTEGER PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
  personality TEXT NOT NULL DEFAULT '',
  speaking_style TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  formality INTEGER NOT NULL DEFAULT 3 CHECK (formality BETWEEN 1 AND 5),
  humor INTEGER NOT NULL DEFAULT 2 CHECK (humor BETWEEN 1 AND 5),
  reply_length TEXT NOT NULL DEFAULT 'medium' CHECK (reply_length IN ('short','medium','long')),
  emoji_usage TEXT NOT NULL DEFAULT 'light' CHECK (emoji_usage IN ('none','light','frequent')),
  addressing TEXT NOT NULL DEFAULT '',
  common_phrases TEXT NOT NULL DEFAULT '[]',
  banned_words TEXT NOT NULL DEFAULT '[]',
  unsuitable_tones TEXT NOT NULL DEFAULT '[]',
  forbidden_promises TEXT NOT NULL DEFAULT '[]',
  signature TEXT NOT NULL DEFAULT '',
  variants TEXT NOT NULL DEFAULT '[]',
  updated_by_id INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- 知識庫
CREATE TABLE IF NOT EXISTS knowledge_items (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_to TEXT,
  review_status TEXT NOT NULL DEFAULT 'approved' CHECK (review_status IN ('approved','pending','rejected')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','from_reply','import')),
  source_comment_id INTEGER REFERENCES comments(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_id INTEGER REFERENCES users(id),
  updated_by_id INTEGER REFERENCES users(id),
  approved_by_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_brand ON knowledge_items(brand_id, is_active);

CREATE TABLE IF NOT EXISTS knowledge_revisions (
  id INTEGER PRIMARY KEY,
  knowledge_id INTEGER NOT NULL REFERENCES knowledge_items(id),
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  version INTEGER NOT NULL,
  change_type TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  changed_by_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_item ON knowledge_revisions(knowledge_id);

-- AI 回覆範例
CREATE TABLE IF NOT EXISTS reply_examples (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  category_id INTEGER REFERENCES comment_categories(id),
  scenario TEXT NOT NULL DEFAULT '',
  sample_comment TEXT NOT NULL DEFAULT '',
  good_reply TEXT NOT NULL DEFAULT '',
  bad_reply TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','rejected','inactive')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','from_reply')),
  source_reply_id INTEGER,
  submitted_by_id INTEGER REFERENCES users(id),
  approved_by_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_examples_brand ON reply_examples(brand_id, status);

-- 標準回覆
CREATE TABLE IF NOT EXISTS canned_replies (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  category_id INTEGER REFERENCES comment_categories(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ========== 自動化規則（階段 4） ==========
CREATE TABLE IF NOT EXISTS automation_rules (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_ids TEXT NOT NULL DEFAULT '[]',
  platforms TEXT NOT NULL DEFAULT '[]',
  conditions TEXT NOT NULL DEFAULT '{}',
  -- 自動化規則不可執行刪除、封鎖
  action TEXT NOT NULL CHECK (action IN ('auto_reply','auto_like','mark_no_action','assign','raise_priority','force_human')),
  action_params TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by_id INTEGER REFERENCES users(id),
  updated_by_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_brand ON automation_rules(brand_id, is_active);

-- ========== 回覆與互動動作 ==========
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY,
  comment_id INTEGER NOT NULL REFERENCES comments(id),
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  body TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual','ai_adopted','ai_edited','canned','auto_rule','batch')),
  ai_suggestion_id INTEGER REFERENCES ai_suggestions(id),
  ai_original_body TEXT,
  was_edited INTEGER NOT NULL DEFAULT 0,
  canned_reply_id INTEGER REFERENCES canned_replies(id),
  -- sent_by_id 為 NULL 代表由自動化規則送出（此時 rule_id 必填）
  sent_by_id INTEGER REFERENCES users(id),
  rule_id INTEGER REFERENCES automation_rules(id),
  batch_job_id INTEGER REFERENCES batch_jobs(id),
  status_after TEXT,
  platform_reply_id TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'sent' CHECK (delivery_status IN ('sent','failed')),
  error TEXT,
  sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (sent_by_id IS NOT NULL OR rule_id IS NOT NULL OR source = 'auto_rule')
);
CREATE INDEX IF NOT EXISTS idx_replies_comment ON replies(comment_id);
CREATE INDEX IF NOT EXISTS idx_replies_brand_sent ON replies(brand_id, sent_at);

-- 按讚、隱藏、刪除、封鎖等互動動作
CREATE TABLE IF NOT EXISTS comment_actions (
  id INTEGER PRIMARY KEY,
  comment_id INTEGER NOT NULL REFERENCES comments(id),
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  action TEXT NOT NULL CHECK (action IN ('like','unlike','hide','unhide','delete','block')),
  suggested_by TEXT CHECK (suggested_by IS NULL OR suggested_by IN ('ai','rule','user')),
  suggestion_reason TEXT NOT NULL DEFAULT '',
  requested_by_id INTEGER REFERENCES users(id),
  confirmed_by_id INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  reason TEXT NOT NULL DEFAULT '',
  rule_id INTEGER REFERENCES automation_rules(id),
  result TEXT NOT NULL DEFAULT 'success' CHECK (result IN ('success','failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  -- 不可妥協：刪除、封鎖一律需要人工確認者與理由，且不能由規則執行
  CHECK (action NOT IN ('delete','block') OR (confirmed_by_id IS NOT NULL AND rule_id IS NULL AND length(trim(reason)) > 0))
);
CREATE INDEX IF NOT EXISTS idx_actions_comment ON comment_actions(comment_id);

-- ========== 監控、洞察（階段 5） ==========
CREATE TABLE IF NOT EXISTS anomaly_events (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('high','medium','low')),
  metrics TEXT NOT NULL DEFAULT '{}',
  related_post_id INTEGER REFERENCES posts(id),
  related_comment_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','acknowledged','in_progress','resolved')),
  dedupe_key TEXT UNIQUE,
  detected_at TEXT NOT NULL,
  acknowledged_by_id INTEGER REFERENCES users(id),
  acknowledged_at TEXT,
  resolved_by_id INTEGER REFERENCES users(id),
  resolved_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anomalies_brand ON anomaly_events(brand_id, status);

CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  evidence_comment_ids TEXT NOT NULL DEFAULT '[]',
  metric_count INTEGER NOT NULL DEFAULT 0,
  generated_by TEXT NOT NULL DEFAULT 'ai',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insights_brand ON insights(brand_id, period_end);

-- ========== 操作紀錄（只能新增，不可修改或刪除） ==========
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER,
  comment_id INTEGER,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','ai','rule','system')),
  actor_user_id INTEGER,
  rule_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  -- 動作當下的案件負責人（用來區分負責人與實際處理人）
  assignee_id_at_time INTEGER,
  batch_job_id INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  before TEXT,
  after TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_brand_time ON audit_logs(brand_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_comment ON audit_logs(comment_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id, created_at);

CREATE TRIGGER IF NOT EXISTS audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs 只能新增，不可修改'); END;
CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs 只能新增，不可刪除'); END;
`;

/** 依相依順序排列的資料表（重設資料時用 DROP 的反向順序） */
export const TABLES_IN_ORDER = [
  'schema_meta',
  'users',
  'brands',
  'user_brands',
  'sessions',
  'social_accounts',
  'posts',
  'comment_categories',
  'brand_category_settings',
  'comment_groups',
  'batch_jobs',
  'comments',
  'assignments',
  'internal_notes',
  'notifications',
  'ai_analyses',
  'ai_suggestions',
  'brand_styles',
  'knowledge_items',
  'knowledge_revisions',
  'reply_examples',
  'canned_replies',
  'automation_rules',
  'replies',
  'comment_actions',
  'anomaly_events',
  'insights',
  'audit_logs',
] as const;
