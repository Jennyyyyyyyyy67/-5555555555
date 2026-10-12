// 留言處理共用邏輯：載入（含品牌權限）、處理中鎖定、通知。
import type { DB } from '../db';
import { all, get, insert, run, sqlIn } from '../db';
import type { BrandScope } from '../auth/scope';
import type { AuthUser } from '../auth/session';
import { addMinutes, nowIso } from '../lib/clock';
import { audit } from './audit';
import { conflict, notFound } from '../lib/errors';
import { LOCK_TTL_MINUTES, type CommentStatus } from '../../shared/constants';

export interface CommentRow {
  id: number;
  brand_id: number;
  social_account_id: number;
  post_id: number;
  parent_comment_id: number | null;
  thread_root_id: number | null;
  external_id: string;
  author_name: string;
  author_external_id: string;
  body: string;
  status: CommentStatus;
  visibility: 'visible' | 'hidden' | 'deleted';
  is_liked: number;
  assignee_id: number | null;
  original_assignee_id: number | null;
  handled_by_id: number | null;
  locked_by_id: number | null;
  lock_expires_at: string | null;
  first_response_at: string | null;
  completed_at: string | null;
  follow_up_at: string | null;
  follow_up_note: string;
}

/** 取得留言；不存在或不在使用者可存取（且啟用中）的品牌 → 404 */
export async function loadComment(db: DB, scope: BrandScope, id: number): Promise<CommentRow> {
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound('找不到留言');
  const row = await get<CommentRow>(db, 'SELECT * FROM comments WHERE id = ?', [id]);
  if (!row || !scope.activeBrandIds.includes(row.brand_id)) throw notFound('找不到留言');
  return row;
}

export function activeLock(row: Pick<CommentRow, 'locked_by_id' | 'lock_expires_at'>, now = nowIso()): number | null {
  return row.locked_by_id && row.lock_expires_at && row.lock_expires_at > now ? row.locked_by_id : null;
}

/** 別人正在處理（鎖定未過期）時擋下操作 */
export async function assertNotLockedByOther(db: DB, row: CommentRow, user: AuthUser): Promise<void> {
  const holder = activeLock(row);
  if (holder && holder !== user.id) {
    const u = await get<{ name: string }>(db, 'SELECT name FROM users WHERE id = ?', [holder]);
    throw conflict(`${u?.name ?? '其他人'} 正在處理這則留言，請稍後再試或請主管協助接手`, { lockedById: holder });
  }
}

/**
 * 釋放過期的處理中鎖定：尚未回覆的留言回到「待處理」（或保留「已轉交」），並留下紀錄。
 * 收件匣讀取時呼叫，避免有人開著畫面離開後留言一直卡在處理中。
 */
export async function releaseExpiredLocks(db: DB, brandIds: number[]): Promise<void> {
  const now = nowIso();
  const expired = await all<{ id: number; brand_id: number; locked_by_id: number; status: CommentStatus; assignee_id: number | null }>(
    db,
    `SELECT id, brand_id, locked_by_id, status, assignee_id FROM comments
     WHERE ${sqlIn('brand_id', brandIds)} AND locked_by_id IS NOT NULL AND lock_expires_at <= ?`,
    [now],
  );
  for (const c of expired) {
    const back = c.status === 'in_progress';
    await run(
      db,
      `UPDATE comments SET locked_by_id = NULL, locked_at = NULL, lock_expires_at = NULL,
         status = CASE WHEN status = 'in_progress' THEN 'pending' ELSE status END, updated_at = ?
       WHERE id = ? AND lock_expires_at <= ?`,
      [now, c.id, now],
    );
    if (back) {
      await audit(db, {
        actorType: 'system',
        brandId: c.brand_id,
        commentId: c.id,
        action: 'comment.lock_expired',
        targetType: 'comment',
        targetId: c.id,
        assigneeIdAtTime: c.assignee_id,
        summary: `處理中超過 ${LOCK_TTL_MINUTES} 分鐘沒有動作，已自動釋放，留言回到待處理`,
        before: { status: 'in_progress' },
        after: { status: 'pending' },
      });
    }
  }
}

export function lockUntil(): string {
  return addMinutes(nowIso(), LOCK_TTL_MINUTES);
}

/** 可存取某品牌、啟用中的人員（管理員 + 被授權者） */
export async function brandDirectory(db: DB, brandId: number): Promise<Array<{ id: number; name: string; role: AuthUser['role'] }>> {
  return all(
    db,
    `SELECT u.id, u.name, u.role FROM users u
     WHERE u.is_active = 1 AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM user_brands ub WHERE ub.user_id = u.id AND ub.brand_id = ?))
     ORDER BY CASE u.role WHEN 'operator' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, u.name`,
    [brandId],
  );
}

export async function notify(
  db: DB,
  n: { userId: number; brandId: number; type: string; commentId: number; message: string },
): Promise<void> {
  await insert(db, 'notifications', {
    user_id: n.userId,
    brand_id: n.brandId,
    type: n.type,
    comment_id: n.commentId,
    message: n.message,
    is_read: false,
    created_at: nowIso(),
  });
}

/** 從備註內容找出 @提及的人（依目錄中的名字比對，名字長的優先） */
export function parseMentions(body: string, directory: Array<{ id: number; name: string }>): number[] {
  const ids = new Set<number>();
  const sorted = [...directory].sort((a, b) => b.name.length - a.name.length);
  for (const u of sorted) {
    if (body.includes(`@${u.name}`)) ids.add(u.id);
  }
  return [...ids];
}
