import type { DB } from '../db';
import { insert } from '../db';
import { nowIso } from '../lib/clock';
import type { ActorType } from '../../shared/constants';

export interface AuditEntry {
  actorType: ActorType;
  /** 人員操作時必填；AI／規則／系統操作時為 null */
  actorUserId?: number | null;
  ruleId?: number | null;
  brandId?: number | null;
  commentId?: number | null;
  /** 動作代碼，格式「領域.動作」，例如 brand.create、comment.reply、auth.login */
  action: string;
  targetType?: string | null;
  targetId?: number | null;
  /** 動作當下的案件負責人（區分負責人與實際處理人） */
  assigneeIdAtTime?: number | null;
  batchJobId?: number | null;
  /** 給人看的繁體中文摘要，例如「新增品牌「日日咖啡」」 */
  summary: string;
  before?: unknown;
  after?: unknown;
  detail?: unknown;
  /** 預設為現在；匯入歷史資料（例如示範資料）時可指定 */
  createdAt?: string;
}

/**
 * 寫入一筆操作紀錄。所有重要操作都必須呼叫；操作紀錄只能新增，不可修改或刪除。
 * 請在與實際資料異動相同的 tx() 中呼叫，確保兩者一起成功或一起失敗。
 */
export function audit(db: DB, e: AuditEntry): number {
  if (e.actorType === 'user' && !e.actorUserId) throw new Error('人員操作的紀錄必須帶 actorUserId');
  if (e.actorType === 'rule' && !e.ruleId) throw new Error('規則操作的紀錄必須帶 ruleId');
  return insert(db, 'audit_logs', {
    brand_id: e.brandId ?? null,
    comment_id: e.commentId ?? null,
    actor_type: e.actorType,
    actor_user_id: e.actorUserId ?? null,
    rule_id: e.ruleId ?? null,
    action: e.action,
    target_type: e.targetType ?? null,
    target_id: e.targetId ?? null,
    assignee_id_at_time: e.assigneeIdAtTime ?? null,
    batch_job_id: e.batchJobId ?? null,
    summary: e.summary,
    before: e.before === undefined ? null : JSON.stringify(e.before),
    after: e.after === undefined ? null : JSON.stringify(e.after),
    detail: e.detail === undefined ? null : JSON.stringify(e.detail),
    created_at: e.createdAt ?? nowIso(),
  });
}

/** 只保留有變動的欄位，用於紀錄 before/after */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T> } | null {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (after[key] === undefined) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}
