// 統一收件匣：列表（急迫排序、篩選）、詳情（前後脈絡）、處理中鎖定、回覆、狀態、指派／轉交、備註、稍後追蹤、互動動作。
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { all, bool, get, insert, parseJson, run, sqlIn, tx, updateById, type DB } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { resolveBrandFilter, type BrandScope } from '../auth/scope';
import type { AuthUser } from '../auth/session';
import { audit } from '../services/audit';
import {
  activeLock,
  assertNotLockedByOther,
  brandDirectory,
  loadComment,
  lockUntil,
  notify,
  parseMentions,
  releaseExpiredLocks,
  type CommentRow,
} from '../services/comments';
import { getAccountType, getAdapter } from '../adapters/registry';
import { badRequest, forbidden, HttpError } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { needsKnowledge } from '../ai/knowledge';
import { adapterAccountFor } from '../services/credentials';
import { autoSyncLive } from '../services/liveSync';
import { can } from '../../shared/permissions';
import {
  COMMENT_STATUSES,
  HIGH_RISK_ACTIONS,
  INTERACTION_ACTIONS,
  INTERACTION_ACTION_LABELS,
  PRIORITIES,
  STATUS_LABELS,
  type CommentStatus,
  type InteractionAction,
} from '../../shared/constants';
import {
  INBOX_TABS,
  type AiSummary,
  type AuditLogEntry,
  type CommentDetail,
  type InboxItem,
  type InboxResponse,
  type InboxTab,
  type NotificationsResponse,
} from '../../shared/types';

const OPEN_TODO = "('pending','in_progress','transferred')";
const SLA_ACTIVE = `c.status IN ${OPEN_TODO} AND c.first_response_at IS NULL AND c.sla_due_at IS NOT NULL`;
const DUE = 'c.sla_due_at::timestamptz';
const NOW = ':now::timestamptz';
const NEAR_LIMIT = `(${NOW} + make_interval(mins => b.near_due_minutes))`;

const TAB_WHERE: Record<InboxTab, string> = {
  todo: `c.status IN ${OPEN_TODO}`,
  mine: "c.assignee_id = :me AND c.status IN ('pending','in_progress','transferred','waiting')",
  unassigned: `c.assignee_id IS NULL AND c.status IN ${OPEN_TODO}`,
  waiting: "c.status = 'waiting'",
  follow_up: "c.follow_up_at IS NOT NULL AND c.status NOT IN ('done','no_action')",
  closed: "c.status IN ('done','no_action')",
  all: 'TRUE',
};

const ITEM_SELECT = `
  SELECT c.id, c.brand_id, b.name AS brand_name, b.color AS brand_color, b.near_due_minutes,
    sa.platform, sa.id AS account_id, sa.name AS account_name, sa.account_type,
    p.id AS post_id, p.title AS post_title, p.content_type, p.is_ad,
    c.parent_comment_id, c.author_name, c.body, c.rating, c.occurred_at, c.fetched_at,
    c.status, c.priority, cc.key AS category_key, cc.name AS category_name,
    c.tags, c.risk_flags, c.risk_level, c.sentiment, c.handling_mode,
    c.assignee_id, au.name AS assignee_name, c.handled_by_id, hu.name AS handled_by_name,
    c.locked_by_id, lu.name AS locked_by_name, c.lock_expires_at,
    c.sla_minutes, c.sla_due_at, c.first_response_at, c.completed_at, c.visibility,
    c.is_auto_handled, c.needs_human, c.is_liked, c.like_count, c.follow_up_at, c.follow_up_note,
    (SELECT COUNT(*) FROM replies r WHERE r.comment_id = c.id) AS reply_count,
    (SELECT COUNT(*) FROM comments t WHERE t.id <> c.id AND (t.id = COALESCE(c.thread_root_id, c.id) OR t.thread_root_id = COALESCE(c.thread_root_id, c.id))) AS thread_count
  FROM comments c
  JOIN brands b ON b.id = c.brand_id
  JOIN social_accounts sa ON sa.id = c.social_account_id
  JOIN posts p ON p.id = c.post_id
  LEFT JOIN comment_categories cc ON cc.id = c.category_id
  LEFT JOIN users au ON au.id = c.assignee_id
  LEFT JOIN users hu ON hu.id = c.handled_by_id
  LEFT JOIN users lu ON lu.id = c.locked_by_id`;

type ItemRow = Record<string, unknown> & {
  id: number;
  locked_by_id: number | null;
  lock_expires_at: string | null;
};

function toItem(r: ItemRow, now: string): InboxItem {
  const locked = r.locked_by_id && r.lock_expires_at && (r.lock_expires_at as string) > now;
  return {
    id: r.id,
    brandId: r.brand_id as number,
    brandName: r.brand_name as string,
    brandColor: r.brand_color as string,
    platform: r.platform as string,
    accountId: r.account_id as number,
    accountName: r.account_name as string,
    accountType: r.account_type as string,
    postId: r.post_id as number,
    postTitle: r.post_title as string,
    contentType: r.content_type as InboxItem['contentType'],
    isAd: bool(r.is_ad),
    parentCommentId: r.parent_comment_id as number | null,
    authorName: r.author_name as string,
    body: r.body as string,
    rating: r.rating as number | null,
    occurredAt: r.occurred_at as string,
    fetchedAt: r.fetched_at as string,
    status: r.status as CommentStatus,
    priority: r.priority as InboxItem['priority'],
    categoryKey: r.category_key as string | null,
    categoryName: r.category_name as string | null,
    tags: parseJson<string[]>(r.tags, []),
    riskFlags: parseJson(r.risk_flags, []),
    riskLevel: r.risk_level as InboxItem['riskLevel'],
    sentiment: r.sentiment as InboxItem['sentiment'],
    handlingMode: r.handling_mode as InboxItem['handlingMode'],
    assigneeId: r.assignee_id as number | null,
    assigneeName: r.assignee_name as string | null,
    slaDueAt: r.sla_due_at as string | null,
    firstResponseAt: r.first_response_at as string | null,
    completedAt: r.completed_at as string | null,
    visibility: r.visibility as InboxItem['visibility'],
    isAutoHandled: bool(r.is_auto_handled),
    slaMinutes: r.sla_minutes as number | null,
    nearDueMinutes: r.near_due_minutes as number,
    needsHuman: bool(r.needs_human),
    isLiked: bool(r.is_liked),
    likeCount: r.like_count as number,
    handledById: r.handled_by_id as number | null,
    handledByName: r.handled_by_name as string | null,
    lockedById: locked ? r.locked_by_id : null,
    lockedByName: locked ? (r.locked_by_name as string) : null,
    lockExpiresAt: locked ? r.lock_expires_at : null,
    followUpAt: r.follow_up_at as string | null,
    followUpNote: (r.follow_up_note as string) ?? '',
    replyCount: r.reply_count as number,
    threadCount: r.thread_count as number,
  };
}

function qs(v: unknown, label: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw badRequest(`「${label}」參數只能帶一個值`);
  const s = v.trim();
  return s === '' ? undefined : s;
}

function qint(v: unknown, label: string): number | undefined {
  const s = qs(v, label);
  if (s === undefined) return undefined;
  if (!/^\d+$/.test(s)) throw badRequest(`「${label}」參數不正確`);
  return Number(s);
}

async function buildDetail(db: DB, user: AuthUser, scope: BrandScope, id: number): Promise<CommentDetail> {
  const now = nowIso();
  const row = await get<ItemRow>(db, `${ITEM_SELECT} WHERE c.id = :id`, { id });
  if (!row || !scope.activeBrandIds.includes(row.brand_id as number)) throw new HttpError(404, 'not_found', '找不到留言');
  const item = toItem(row, now);
  const extra = (await get<{
    original_assignee_name: string | null;
    original_assignee_id: number | null;
    first_response_type: 'human' | 'ai_auto' | null;
    first_response_by_name: string | null;
    author_external_id: string;
    thread_root_id: number | null;
  }>(
    db,
    `SELECT c.original_assignee_id, ou.name AS original_assignee_name, c.first_response_type, fu.name AS first_response_by_name,
       c.author_external_id, c.thread_root_id
     FROM comments c LEFT JOIN users ou ON ou.id = c.original_assignee_id LEFT JOIN users fu ON fu.id = c.first_response_by_id
     WHERE c.id = ?`,
    [id],
  ))!;
  const post = (await get<{ id: number; title: string; body: string; url: string; content_type: InboxItem['contentType']; is_ad: number; ad_campaign: string | null; published_at: string }>(
    db,
    'SELECT id, title, body, url, content_type, is_ad, ad_campaign, published_at FROM posts WHERE id = ?',
    [item.postId],
  ))!;
  const account = (await get<{ id: number; name: string; handle: string; platform: string; account_type: string }>(
    db,
    'SELECT id, name, handle, platform, account_type FROM social_accounts WHERE id = ?',
    [item.accountId],
  ))!;
  const caps = getAccountType(account.platform, account.account_type)?.capabilities ?? { reply: false, like: false, hide: false, delete: false, block: false };

  const root = extra.thread_root_id ?? id;
  const threadComments = await all<{ id: number; parent_comment_id: number | null; author_name: string; body: string; rating: number | null; occurred_at: string; status: CommentStatus; visibility: InboxItem['visibility'] }>(
    db,
    'SELECT id, parent_comment_id, author_name, body, rating, occurred_at, status, visibility FROM comments WHERE id = ? OR thread_root_id = ? ORDER BY occurred_at, id',
    [root, root],
  );
  const ids = threadComments.map((t) => t.id);
  const threadReplies = await all<{ id: number; comment_id: number; body: string; sent_at: string; sender_name: string | null; source: string }>(
    db,
    `SELECT r.id, r.comment_id, r.body, r.sent_at, u.name AS sender_name, r.source FROM replies r LEFT JOIN users u ON u.id = r.sent_by_id
     WHERE ${sqlIn('r.comment_id', ids)} AND r.delivery_status = 'sent' ORDER BY r.sent_at, r.id`,
  );
  const thread: CommentDetail['thread'] = [
    ...threadComments.map((t) => ({
      kind: 'comment' as const,
      id: t.id,
      parentId: t.parent_comment_id,
      authorName: t.author_name,
      body: t.body,
      rating: t.rating,
      occurredAt: t.occurred_at,
      status: t.status,
      visibility: t.visibility,
      isCurrent: t.id === id,
    })),
    ...threadReplies.map((r) => ({ kind: 'reply' as const, id: r.id, commentId: r.comment_id, body: r.body, sentAt: r.sent_at, senderName: r.sender_name, source: r.source })),
  ].sort((a, b) => (a.kind === 'comment' ? a.occurredAt : a.sentAt).localeCompare(b.kind === 'comment' ? b.occurredAt : b.sentAt));

  const replies = (
    await all<{ id: number; body: string; source: string; sent_at: string; sent_by_id: number | null; sender_name: string | null; status_after: CommentStatus | null; delivery_status: 'sent' | 'failed' }>(
      db,
      'SELECT r.id, r.body, r.source, r.sent_at, r.sent_by_id, u.name AS sender_name, r.status_after, r.delivery_status FROM replies r LEFT JOIN users u ON u.id = r.sent_by_id WHERE r.comment_id = ? ORDER BY r.sent_at, r.id',
      [id],
    )
  ).map((r) => ({ id: r.id, body: r.body, source: r.source, sentAt: r.sent_at, senderId: r.sent_by_id, senderName: r.sender_name, statusAfter: r.status_after, deliveryStatus: r.delivery_status }));

  const assignments = (
    await all<{ id: number; from_name: string | null; to_name: string | null; by_name: string | null; reason: string; created_at: string }>(
      db,
      `SELECT a.id, fu.name AS from_name, tu.name AS to_name, bu.name AS by_name, a.reason, a.created_at FROM assignments a
       LEFT JOIN users fu ON fu.id = a.from_user_id LEFT JOIN users tu ON tu.id = a.to_user_id LEFT JOIN users bu ON bu.id = a.assigned_by_id
       WHERE a.comment_id = ? ORDER BY a.created_at, a.id`,
      [id],
    )
  ).map((a) => ({ id: a.id, fromName: a.from_name, toName: a.to_name, byName: a.by_name, reason: a.reason, createdAt: a.created_at }));

  const notes = (
    await all<{ id: number; user_id: number; user_name: string; body: string; mentions: string; created_at: string }>(
      db,
      'SELECT n.id, n.user_id, u.name AS user_name, n.body, n.mentions, n.created_at FROM internal_notes n JOIN users u ON u.id = n.user_id WHERE n.comment_id = ? ORDER BY n.created_at, n.id',
      [id],
    )
  ).map((n) => ({ id: n.id, userId: n.user_id, userName: n.user_name, body: n.body, mentions: parseJson<number[]>(n.mentions, []), createdAt: n.created_at }));

  const actions = (
    await all<{ id: number; action: string; reason: string; requested_name: string | null; confirmed_name: string | null; result: 'success' | 'failed'; created_at: string; rule_id: number | null }>(
      db,
      `SELECT ca.id, ca.action, ca.reason, ru.name AS requested_name, cu.name AS confirmed_name, ca.result, ca.created_at, ca.rule_id
       FROM comment_actions ca LEFT JOIN users ru ON ru.id = ca.requested_by_id LEFT JOIN users cu ON cu.id = ca.confirmed_by_id
       WHERE ca.comment_id = ? ORDER BY ca.created_at, ca.id`,
      [id],
    )
  ).map((a) => ({
    id: a.id,
    action: a.action,
    reason: a.reason,
    requestedByName: a.requested_name ?? (a.rule_id ? '自動化規則' : null),
    confirmedByName: a.confirmed_name,
    result: a.result,
    createdAt: a.created_at,
  }));

  const history: AuditLogEntry[] = (
    await all<{ id: number; brand_id: number | null; comment_id: number | null; actor_type: AuditLogEntry['actorType']; actor_user_id: number | null; actor_name: string | null; rule_id: number | null; action: string; target_type: string | null; target_id: number | null; summary: string; before: string | null; after: string | null; detail: string | null; created_at: string }>(
      db,
      `SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.comment_id = ? ORDER BY a.created_at, a.id`,
      [id],
    )
  ).map((a) => ({
    id: a.id,
    brandId: a.brand_id,
    brandName: item.brandName,
    commentId: a.comment_id,
    actorType: a.actor_type,
    actorUserId: a.actor_user_id,
    actorName: a.actor_name,
    ruleId: a.rule_id,
    action: a.action,
    targetType: a.target_type,
    targetId: a.target_id,
    summary: a.summary,
    before: parseJson(a.before, null),
    after: parseJson(a.after, null),
    detail: parseJson(a.detail, null),
    createdAt: a.created_at,
  }));

  const lock = item.lockedById ? { byId: item.lockedById, byName: item.lockedByName ?? '', expiresAt: item.lockExpiresAt!, isMine: item.lockedById === user.id } : null;
  return {
    comment: {
      ...item,
      originalAssigneeId: extra.original_assignee_id,
      originalAssigneeName: extra.original_assignee_name,
      firstResponseType: extra.first_response_type,
      firstResponseByName: extra.first_response_by_name,
      authorExternalId: extra.author_external_id,
    },
    post: {
      id: post.id,
      title: post.title,
      body: post.body,
      url: post.url,
      contentType: post.content_type,
      isAd: post.is_ad === 1,
      adCampaign: post.ad_campaign,
      publishedAt: post.published_at,
    },
    account: { id: account.id, name: account.name, handle: account.handle, platform: account.platform, accountType: account.account_type, capabilities: caps },
    thread,
    replies,
    assignments,
    notes,
    actions,
    history,
    lock,
    directory: await brandDirectory(db, item.brandId),
    ai: await loadAiSummary(db, id, item.categoryKey),
    permissions: {
      canHandle: !lock || lock.isMine,
      canReassign: can(user.role, 'reassignComments'),
      canOverrideLock: can(user.role, 'overrideLock'),
    },
    serverTime: now,
  };
}

/** 最新一次 AI 判斷（含是否被人工修正） */
async function loadAiSummary(db: DB, commentId: number, currentCategoryKey: string | null): Promise<AiSummary | null> {
  const a = await get<{ provider: string; created_at: string; confidence: number | null; priority_reasons: string; force_human_reasons: string; knowledge_gap: number; category_key: string | null; category_name: string | null }>(
    db,
    `SELECT a.provider, a.created_at, a.confidence, a.priority_reasons, a.force_human_reasons, a.knowledge_gap, a.category_key, cc.name AS category_name
     FROM ai_analyses a LEFT JOIN comment_categories cc ON cc.key = a.category_key WHERE a.comment_id = ? ORDER BY a.id DESC LIMIT 1`,
    [commentId],
  );
  if (!a) return null;
  const corrected = await get<{ name: string | null }>(
    db,
    `SELECT u.name FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_user_id WHERE l.comment_id = ? AND l.action = 'comment.reclassify' ORDER BY l.id DESC LIMIT 1`,
    [commentId],
  );
  return {
    provider: a.provider,
    analyzedAt: a.created_at,
    confidence: a.confidence,
    reasons: parseJson<string[]>(a.priority_reasons, []),
    forceHuman: parseJson<Array<{ code: string; label: string }>>(a.force_human_reasons, []),
    needsKnowledge: needsKnowledge(currentCategoryKey ?? a.category_key ?? ''),
    knowledgeGap: a.knowledge_gap === 1,
    correctedByName: corrected ? (corrected.name ?? '') : null,
    originalCategoryName: a.category_key && a.category_key !== currentCategoryKey ? a.category_name : null,
  };
}

/** 把留言指派給自己（尚未有負責人時），回傳是否有變更 */
async function claimIfUnassigned(db: DB, c: CommentRow, user: AuthUser, reason: string): Promise<boolean> {
  if (c.assignee_id) return false;
  await updateById(db, 'comments', c.id, { assignee_id: user.id, original_assignee_id: c.original_assignee_id ?? user.id });
  await insert(db, 'assignments', {
    comment_id: c.id,
    brand_id: c.brand_id,
    from_user_id: null,
    to_user_id: user.id,
    assigned_by_id: user.id,
    reason,
    created_at: nowIso(),
  });
  await audit(db, {
    actorType: 'user',
    actorUserId: user.id,
    brandId: c.brand_id,
    commentId: c.id,
    action: 'comment.assign',
    targetType: 'comment',
    targetId: c.id,
    summary: `${user.name} 認領留言（${reason}）`,
    after: { assigneeId: user.id },
  });
  return true;
}


export function inboxRoutes(): Router {
  const r = Router();
  r.use(requirePermission('handleComments'));

  // ---------- 列表 ----------
  r.get('/', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand).filter((id) => scope.activeBrandIds.includes(id));
    await releaseExpiredLocks(req.db, brandIds);
    const now = nowIso();

    // 已連結真實平台（例如 Instagram）的帳號：每隔一段時間自動抓新留言
    await autoSyncLive(req.db, brandIds);
    const tab = (qs(req.query.tab, '分頁') ?? 'todo') as InboxTab;
    if (!(INBOX_TABS as readonly string[]).includes(tab)) throw badRequest('分頁參數不正確');
    const where = [sqlIn('c.brand_id', brandIds), TAB_WHERE[tab]];
    const params: Record<string, unknown> = { now, me: user.id };

    const platform = qs(req.query.platform, '平台');
    if (platform) (where.push('sa.platform = :platform'), (params.platform = platform));
    const accountId = qint(req.query.accountId, '社群帳號');
    if (accountId) (where.push('c.social_account_id = :accountId'), (params.accountId = accountId));
    const postId = qint(req.query.postId, '貼文');
    if (postId) (where.push('c.post_id = :postId'), (params.postId = postId));
    if (qs(req.query.adOnly, '只看廣告') === '1') where.push('p.is_ad = 1');
    const category = qs(req.query.category, '留言類型');
    if (category) (where.push('cc.key = :category'), (params.category = category));
    const status = qs(req.query.status, '狀態');
    if (status) {
      if (!(COMMENT_STATUSES as readonly string[]).includes(status)) throw badRequest('狀態參數不正確');
      where.push('c.status = :status');
      params.status = status;
    }
    const priority = qs(req.query.priority, '優先級');
    if (priority) {
      if (!(PRIORITIES as readonly string[]).includes(priority)) throw badRequest('優先級參數不正確');
      where.push('c.priority = :priority');
      params.priority = priority;
    }
    const assignee = qs(req.query.assignee, '負責人');
    if (assignee === 'me') where.push('c.assignee_id = :me');
    else if (assignee === 'none') where.push('c.assignee_id IS NULL');
    else if (assignee) {
      if (!/^\d+$/.test(assignee)) throw badRequest('負責人參數不正確');
      where.push('c.assignee_id = :assigneeId');
      params.assigneeId = Number(assignee);
    }
    const sla = qs(req.query.sla, '時效');
    if (sla === 'overdue') where.push(`${SLA_ACTIVE} AND ${DUE} < ${NOW}`);
    else if (sla === 'near') where.push(`${SLA_ACTIVE} AND ${DUE} >= ${NOW} AND ${DUE} < ${NEAR_LIMIT}`);
    else if (sla) throw badRequest('時效參數不正確');
    const auto = qs(req.query.auto, 'AI 自動處理');
    if (auto === '1') where.push('c.is_auto_handled = 1');
    else if (auto === '0') where.push('c.is_auto_handled = 0');
    const q = qs(req.query.q, '搜尋');
    if (q) {
      if (q.length > 100) throw badRequest('搜尋文字最多 100 個字');
      where.push("(c.body ILIKE :q ESCAPE '\\' OR c.author_name ILIKE :q ESCAPE '\\')");
      params.q = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    }
    const limit = Math.min(qint(req.query.limit, '每頁筆數') ?? 50, 200);
    const offset = qint(req.query.offset, '起始位置') ?? 0;
    const sort = qs(req.query.sort, '排序') ?? (tab === 'closed' || tab === 'all' ? 'newest' : 'urgency');

    const fromSql = `FROM comments c JOIN brands b ON b.id = c.brand_id JOIN social_accounts sa ON sa.id = c.social_account_id
      JOIN posts p ON p.id = c.post_id LEFT JOIN comment_categories cc ON cc.id = c.category_id`;
    const whereSql = where.join(' AND ');
    const orderSql =
      sort === 'newest'
        ? 'c.occurred_at DESC, c.id DESC'
        : `CASE WHEN ${SLA_ACTIVE} AND ${DUE} < ${NOW} THEN 0
                WHEN ${SLA_ACTIVE} AND ${DUE} < ${NEAR_LIMIT} THEN 1
                WHEN ${SLA_ACTIVE} THEN 2
                WHEN c.status IN ${OPEN_TODO} THEN 3 ELSE 4 END,
           CASE c.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
           c.sla_due_at ASC NULLS LAST, c.occurred_at DESC, c.id DESC`;

    const total = (await get<{ n: number }>(req.db, `SELECT COUNT(*) AS n ${fromSql} WHERE ${whereSql}`, params))?.n ?? 0;
    const rows = await all<ItemRow>(req.db, `${ITEM_SELECT} WHERE ${whereSql} ORDER BY ${orderSql} LIMIT :limit OFFSET :offset`, { ...params, limit, offset });

    // 各分頁筆數與時效統計（只依品牌範圍）
    const scopeWhere = sqlIn('c.brand_id', brandIds);
    const counts = (await get<Record<string, number>>(
      req.db,
      `SELECT ${INBOX_TABS.map((t) => `SUM(CASE WHEN ${TAB_WHERE[t]} THEN 1 ELSE 0 END) AS ${t}`).join(', ')},
         SUM(CASE WHEN ${SLA_ACTIVE} AND ${DUE} < ${NOW} THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN ${SLA_ACTIVE} AND ${DUE} >= ${NOW} AND ${DUE} < ${NEAR_LIMIT} THEN 1 ELSE 0 END) AS near_due
       FROM comments c JOIN brands b ON b.id = c.brand_id WHERE ${scopeWhere}`,
      { now, me: user.id },
    ))!;

    const body: InboxResponse = {
      items: rows.map((x) => toItem(x, now)),
      total,
      limit,
      offset,
      serverTime: now,
      tabCounts: Object.fromEntries(INBOX_TABS.map((t) => [t, Number(counts[t] ?? 0)])) as InboxResponse['tabCounts'],
      overdue: Number(counts.overdue ?? 0),
      nearDue: Number(counts.near_due ?? 0),
    };
    res.json(body);
  });

  // ---------- 詳情 ----------
  r.get('/:id', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const c = await loadComment(req.db, scope, Number(req.params.id));
    await releaseExpiredLocks(req.db, [c.brand_id]);
    res.json(await buildDetail(req.db, user, scope, c.id));
  });

  // ---------- 處理中鎖定 ----------
  r.post('/:id/lock', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const { force } = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    const db = req.db;
    await tx(db, async () => {
      const c = await loadComment(db, scope, Number(req.params.id));
      const holder = activeLock(c);
      if (holder && holder !== user.id) {
        if (!force) await assertNotLockedByOther(db, c, user);
        if (!can(user.role, 'overrideLock')) throw forbidden('只有主管或管理員可以接手別人正在處理的留言');
        const prev = await get<{ name: string }>(db, 'SELECT name FROM users WHERE id = ?', [holder]);
        await audit(db, {
          actorType: 'user',
          actorUserId: user.id,
          brandId: c.brand_id,
          commentId: c.id,
          action: 'comment.lock_override',
          targetType: 'comment',
          targetId: c.id,
          assigneeIdAtTime: c.assignee_id,
          summary: `${user.name} 接手 ${prev?.name ?? ''} 正在處理的留言`,
          before: { lockedById: holder },
          after: { lockedById: user.id },
        });
        await notify(db, { userId: holder, brandId: c.brand_id, type: 'lock_override', commentId: c.id, message: `${user.name} 接手了你正在處理的留言` });
      }
      const now = nowIso();
      const newStatus: CommentStatus = c.status === 'pending' || c.status === 'transferred' ? 'in_progress' : c.status;
      await updateById(db, 'comments', c.id, { locked_by_id: user.id, locked_at: now, lock_expires_at: lockUntil(), status: newStatus, updated_at: now });
      if (newStatus !== c.status) {
        await audit(db, {
          actorType: 'user',
          actorUserId: user.id,
          brandId: c.brand_id,
          commentId: c.id,
          action: 'comment.status_change',
          targetType: 'comment',
          targetId: c.id,
          assigneeIdAtTime: c.assignee_id,
          summary: `${user.name} 開始處理（${STATUS_LABELS[c.status]} → ${STATUS_LABELS[newStatus]}）`,
          before: { status: c.status },
          after: { status: newStatus },
        });
      }
      await claimIfUnassigned(db, c, user, '開始處理時自動認領');
    });
    res.json(await buildDetail(db, user, scope, Number(req.params.id)));
  });

  r.delete('/:id/lock', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const db = req.db;
    await tx(db, async () => {
      const c = await loadComment(db, scope, Number(req.params.id));
      if (activeLock(c) !== user.id) return;
      const back = c.status === 'in_progress' && !c.first_response_at;
      await updateById(db, 'comments', c.id, {
        locked_by_id: null,
        locked_at: null,
        lock_expires_at: null,
        status: back ? 'pending' : c.status,
        updated_at: nowIso(),
      });
      if (back) {
        await audit(db, {
          actorType: 'user',
          actorUserId: user.id,
          brandId: c.brand_id,
          commentId: c.id,
          action: 'comment.release',
          targetType: 'comment',
          targetId: c.id,
          assigneeIdAtTime: c.assignee_id,
          summary: `${user.name} 暫停處理，留言回到待處理`,
          before: { status: 'in_progress' },
          after: { status: 'pending' },
        });
      }
    });
    res.json(await buildDetail(db, user, scope, Number(req.params.id)));
  });

  // ---------- 回覆 ----------
  const replySchema = z.object({
    body: z.string().trim().min(1, '請輸入回覆內容').max(2000, '回覆最多 2000 個字'),
    statusAfter: z.enum(['waiting', 'done'], { errorMap: () => ({ message: '請選擇回覆後的狀態：等待對方或已完成' }) }),
  });
  r.post('/:id/reply', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = replySchema.parse(req.body);
    const db = req.db;
    const c = await loadComment(db, scope, Number(req.params.id));
    await assertNotLockedByOther(db, c, user);
    if (c.visibility === 'deleted') throw badRequest('這則留言已刪除，無法回覆');
    const account = (await get<{ id: number; brand_id: number; platform: string; account_type: string; external_id: string; name: string }>(
      db,
      'SELECT id, brand_id, platform, account_type, external_id, name FROM social_accounts WHERE id = ?',
      [c.social_account_id],
    ))!;
    if (!getAccountType(account.platform, account.account_type)?.capabilities.reply) throw badRequest('此平台帳號不支援回覆');
    const post = (await get<{ external_id: string }>(db, 'SELECT external_id FROM posts WHERE id = ?', [c.post_id]))!;
    const adapter = getAdapter(account.platform);
    const sent = adapter
      ? await adapter.replyToComment(await adapterAccountFor(db, account), { externalId: c.external_id, postExternalId: post.external_id }, input.body)
      : ({ ok: false, error: '找不到平台 adapter' } as const);
    if (!sent.ok) throw new HttpError(502, 'platform_error', `平台回覆失敗：${sent.error}。請稍後再試。`);

    await tx(db, async () => {
      const fresh = await loadComment(db, scope, c.id);
      await assertNotLockedByOther(db, fresh, user);
      const now = nowIso();
      const replyId = await insert(db, 'replies', {
        comment_id: c.id,
        brand_id: c.brand_id,
        body: input.body,
        source: 'manual',
        was_edited: false,
        sent_by_id: user.id,
        status_after: input.statusAfter,
        platform_reply_id: sent.externalReplyId,
        delivery_status: 'sent',
        sent_at: now,
        created_at: now,
      });
      const slaRow = await get<{ sla_due_at: string | null }>(db, 'SELECT sla_due_at FROM comments WHERE id = ?', [c.id]);
      const first = !fresh.first_response_at;
      await updateById(db, 'comments', c.id, {
        status: input.statusAfter,
        handled_by_id: user.id,
        first_response_at: first ? now : undefined,
        first_response_type: first ? 'human' : undefined,
        first_response_by_id: first ? user.id : undefined,
        completed_at: input.statusAfter === 'done' ? now : null,
        locked_by_id: null,
        locked_at: null,
        lock_expires_at: null,
        updated_at: now,
      });
      await claimIfUnassigned(db, fresh, user, '回覆時自動認領');
      await audit(db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: c.brand_id,
        commentId: c.id,
        action: 'comment.reply',
        targetType: 'comment',
        targetId: c.id,
        assigneeIdAtTime: fresh.assignee_id ?? user.id,
        summary: `${user.name} 回覆留言，狀態改為「${STATUS_LABELS[input.statusAfter]}」`,
        before: { status: fresh.status },
        after: { status: input.statusAfter },
        detail: {
          replyId,
          body: input.body,
          firstResponse: first,
          slaMet: first && slaRow?.sla_due_at ? now <= slaRow.sla_due_at : null,
        },
      });
    });
    res.status(201).json(await buildDetail(db, user, scope, c.id));
  });

  // ---------- 狀態 ----------
  const statusSchema = z.object({
    status: z.enum(['pending', 'waiting', 'no_action', 'done'], { errorMap: () => ({ message: '狀態不正確' }) }),
    reason: z.string().trim().max(300).optional(),
  });
  r.post('/:id/status', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = statusSchema.parse(req.body);
    const db = req.db;
    await tx(db, async () => {
      const c = await loadComment(db, scope, Number(req.params.id));
      await assertNotLockedByOther(db, c, user);
      if (c.status === input.status) return;
      if (input.status === 'waiting' && !c.first_response_at) throw badRequest('還沒有回覆過這則留言，無法標示為「等待對方」');
      const now = nowIso();
      const closing = input.status === 'done' || input.status === 'no_action';
      await updateById(db, 'comments', c.id, {
        status: input.status,
        completed_at: closing ? now : null,
        handled_by_id: closing ? user.id : undefined,
        locked_by_id: null,
        locked_at: null,
        lock_expires_at: null,
        updated_at: now,
      });
      await audit(db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: c.brand_id,
        commentId: c.id,
        action: 'comment.status_change',
        targetType: 'comment',
        targetId: c.id,
        assigneeIdAtTime: c.assignee_id,
        summary: `${user.name} 將狀態由「${STATUS_LABELS[c.status]}」改為「${STATUS_LABELS[input.status]}」${input.reason ? `：${input.reason}` : ''}`,
        before: { status: c.status },
        after: { status: input.status },
        detail: input.reason ? { reason: input.reason } : undefined,
      });
    });
    res.json(await buildDetail(db, user, scope, Number(req.params.id)));
  });

  // ---------- 指派／轉交 ----------
  const assignSchema = z.object({
    assigneeId: z.number().int().positive().nullable(),
    reason: z.string().trim().max(300).optional(),
  });
  r.post('/:id/assign', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = assignSchema.parse(req.body);
    const db = req.db;
    await tx(db, async () => {
      const c = await loadComment(db, scope, Number(req.params.id));
      if (c.assignee_id === input.assigneeId) return;
      const canReassign = can(user.role, 'reassignComments');
      // 操作人員：只能認領未指派的留言，或把自己負責的留言轉交出去
      if (!canReassign && c.assignee_id && c.assignee_id !== user.id) throw forbidden('這則留言已有負責人，只有負責人、主管或管理員可以轉交');
      if (!canReassign && input.assigneeId === null) throw forbidden('只有主管或管理員可以取消指派');
      let target: { id: number; name: string } | null = null;
      if (input.assigneeId !== null) {
        const dir = await brandDirectory(db, c.brand_id);
        target = dir.find((u) => u.id === input.assigneeId) ?? null;
        if (!target) throw badRequest('這位人員沒有此品牌的權限或已停用，無法指派');
      }
      const now = nowIso();
      const transferring = target !== null && target.id !== user.id;
      const open = ['pending', 'in_progress', 'transferred'].includes(c.status);
      const nextStatus: CommentStatus = transferring && open ? 'transferred' : !transferring && c.status === 'transferred' ? 'pending' : c.status;
      const holder = activeLock(c);
      await updateById(db, 'comments', c.id, {
        assignee_id: target?.id ?? null,
        original_assignee_id: c.original_assignee_id ?? target?.id ?? null,
        status: nextStatus,
        locked_by_id: holder && holder !== target?.id ? null : undefined,
        locked_at: holder && holder !== target?.id ? null : undefined,
        lock_expires_at: holder && holder !== target?.id ? null : undefined,
        updated_at: now,
      });
      await insert(db, 'assignments', {
        comment_id: c.id,
        brand_id: c.brand_id,
        from_user_id: c.assignee_id,
        to_user_id: target?.id ?? null,
        assigned_by_id: user.id,
        reason: input.reason ?? '',
        created_at: now,
      });
      const fromName = c.assignee_id ? (await get<{ name: string }>(db, 'SELECT name FROM users WHERE id = ?', [c.assignee_id]))?.name : null;
      await audit(db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: c.brand_id,
        commentId: c.id,
        action: c.assignee_id ? 'comment.transfer' : 'comment.assign',
        targetType: 'comment',
        targetId: c.id,
        assigneeIdAtTime: c.assignee_id,
        summary: target
          ? `${user.name} ${c.assignee_id ? `將留言由 ${fromName} 轉交給` : '將留言指派給'} ${target.name}${input.reason ? `：${input.reason}` : ''}`
          : `${user.name} 取消指派（原負責人 ${fromName}）`,
        before: { assigneeId: c.assignee_id, status: c.status },
        after: { assigneeId: target?.id ?? null, status: nextStatus },
      });
      if (target && target.id !== user.id) {
        await notify(db, {
          userId: target.id,
          brandId: c.brand_id,
          type: c.assignee_id ? 'transferred' : 'assigned',
          commentId: c.id,
          message: `${user.name} 把一則留言${c.assignee_id ? '轉交' : '指派'}給你${input.reason ? `：${input.reason}` : ''}`,
        });
      }
    });
    res.json(await buildDetail(db, user, scope, Number(req.params.id)));
  });

  // ---------- 內部備註與 @ ----------
  r.post('/:id/notes', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const { body } = z.object({ body: z.string().trim().min(1, '請輸入備註內容').max(1000, '備註最多 1000 個字') }).parse(req.body);
    const db = req.db;
    await tx(db, async () => {
      const c = await loadComment(db, scope, Number(req.params.id));
      const dir = await brandDirectory(db, c.brand_id);
      const mentions = parseMentions(body, dir);
      const noteId = await insert(db, 'internal_notes', { comment_id: c.id, brand_id: c.brand_id, user_id: user.id, body, mentions, created_at: nowIso() });
      for (const m of mentions.filter((m) => m !== user.id)) {
        await notify(db, { userId: m, brandId: c.brand_id, type: 'mention', commentId: c.id, message: `${user.name} 在備註中提到你：${body.slice(0, 60)}` });
      }
      await audit(db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: c.brand_id,
        commentId: c.id,
        action: 'comment.note',
        targetType: 'comment',
        targetId: c.id,
        assigneeIdAtTime: c.assignee_id,
        summary: `${user.name} 新增內部備註${mentions.length ? `並提到 ${mentions.map((m) => dir.find((u) => u.id === m)?.name).join('、')}` : ''}`,
        detail: { noteId, mentions },
      });
    });
    res.status(201).json(await buildDetail(db, user, scope, Number(req.params.id)));
  });

  // ---------- 稍後追蹤 ----------
  r.post('/:id/follow-up', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = z
      .object({
        at: z.string().datetime({ message: '追蹤時間格式不正確' }).nullable(),
        note: z.string().trim().max(200, '追蹤備註最多 200 個字').optional(),
      })
      .parse(req.body);
    const db = req.db;
    await tx(db, async () => {
      const c = await loadComment(db, scope, Number(req.params.id));
      await updateById(db, 'comments', c.id, { follow_up_at: input.at, follow_up_note: input.at ? (input.note ?? '') : '', updated_at: nowIso() });
      await audit(db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: c.brand_id,
        commentId: c.id,
        action: input.at ? 'comment.follow_up_set' : 'comment.follow_up_clear',
        targetType: 'comment',
        targetId: c.id,
        assigneeIdAtTime: c.assignee_id,
        summary: input.at ? `${user.name} 設定稍後追蹤${input.note ? `：${input.note}` : ''}` : `${user.name} 取消稍後追蹤`,
        before: { followUpAt: c.follow_up_at },
        after: { followUpAt: input.at },
      });
    });
    res.json(await buildDetail(db, user, scope, Number(req.params.id)));
  });

  // ---------- 互動動作（按讚、隱藏、刪除、封鎖） ----------
  const actionSchema = z.object({
    action: z.enum(INTERACTION_ACTIONS, { errorMap: () => ({ message: '動作不正確' }) }),
    reason: z.string().trim().max(300).optional(),
    confirm: z.boolean().optional(),
  });
  r.post('/:id/actions', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = actionSchema.parse(req.body);
    const db = req.db;
    const action = input.action as InteractionAction;
    const highRisk = HIGH_RISK_ACTIONS.includes(action);
    if (highRisk && (!input.confirm || !input.reason)) {
      throw badRequest(`「${INTERACTION_ACTION_LABELS[action]}」屬於高風險動作，必須確認並填寫理由`);
    }
    const c = await loadComment(db, scope, Number(req.params.id));
    await assertNotLockedByOther(db, c, user);
    const account = (await get<{ id: number; brand_id: number; platform: string; account_type: string; external_id: string; name: string }>(
      db,
      'SELECT id, brand_id, platform, account_type, external_id, name FROM social_accounts WHERE id = ?',
      [c.social_account_id],
    ))!;
    const caps = getAccountType(account.platform, account.account_type)?.capabilities;
    const capKey = action === 'like' || action === 'unlike' ? 'like' : action === 'hide' || action === 'unhide' ? 'hide' : action;
    if (!caps?.[capKey]) throw badRequest(`此平台不支援「${INTERACTION_ACTION_LABELS[action]}」`);
    if (c.visibility === 'deleted') throw badRequest('這則留言已刪除');
    const already =
      (action === 'like' && c.is_liked === 1) ||
      (action === 'unlike' && c.is_liked === 0) ||
      (action === 'hide' && c.visibility === 'hidden') ||
      (action === 'unhide' && c.visibility === 'visible');
    if (already) throw badRequest('目前已經是這個狀態');
    const post = (await get<{ external_id: string }>(db, 'SELECT external_id FROM posts WHERE id = ?', [c.post_id]))!;
    const result = await getAdapter(account.platform)!.performAction(await adapterAccountFor(db, account), { externalId: c.external_id, postExternalId: post.external_id }, action);
    if (!result.ok) throw new HttpError(502, 'platform_error', `平台執行失敗：${result.error}`);

    await tx(db, async () => {
      const now = nowIso();
      await insert(db, 'comment_actions', {
        comment_id: c.id,
        brand_id: c.brand_id,
        action,
        suggested_by: 'user',
        requested_by_id: user.id,
        confirmed_by_id: user.id,
        confirmed_at: now,
        reason: input.reason ?? '',
        result: 'success',
        created_at: now,
      });
      const closeOnDelete = action === 'delete' && ['pending', 'in_progress', 'transferred', 'waiting'].includes(c.status);
      await updateById(db, 'comments', c.id, {
        is_liked: action === 'like' ? true : action === 'unlike' ? false : undefined,
        visibility: action === 'hide' ? 'hidden' : action === 'unhide' ? 'visible' : action === 'delete' ? 'deleted' : undefined,
        status: closeOnDelete ? 'no_action' : undefined,
        completed_at: closeOnDelete ? now : undefined,
        handled_by_id: closeOnDelete ? user.id : undefined,
        updated_at: now,
      });
      await audit(db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: c.brand_id,
        commentId: c.id,
        action: `comment.${action}`,
        targetType: 'comment',
        targetId: c.id,
        assigneeIdAtTime: c.assignee_id,
        summary: `${user.name} ${INTERACTION_ACTION_LABELS[action]}${input.reason ? `：${input.reason}` : ''}`,
        detail: { reason: input.reason ?? null },
      });
    });
    res.json(await buildDetail(db, user, scope, c.id));
  });

  return r;
}

/** 通知：@提及、指派、轉交、被接手 */
export function notificationRoutes(): Router {
  const r = Router();
  r.get('/', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const rows = await all<{ id: number; type: string; message: string; comment_id: number | null; brand_id: number | null; is_read: number; created_at: string }>(
      req.db,
      `SELECT id, type, message, comment_id, brand_id, is_read, created_at FROM notifications
       WHERE user_id = ? AND (brand_id IS NULL OR ${sqlIn('brand_id', scope.activeBrandIds)})
       ORDER BY created_at DESC, id DESC LIMIT 30`,
      [user.id],
    );
    const unread = await get<{ n: number }>(
      req.db,
      `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0 AND (brand_id IS NULL OR ${sqlIn('brand_id', scope.activeBrandIds)})`,
      [user.id],
    );
    const body: NotificationsResponse = {
      items: rows.map((n) => ({ id: n.id, type: n.type, message: n.message, commentId: n.comment_id, brandId: n.brand_id, isRead: n.is_read === 1, createdAt: n.created_at })),
      unread: unread?.n ?? 0,
    };
    res.json(body);
  });
  r.post('/read', async (req: Request, res: Response) => {
    const { user } = authed(req);
    const { ids } = z.object({ ids: z.array(z.number().int()).optional() }).parse(req.body ?? {});
    if (ids?.length) {
      await run(req.db, `UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND ${sqlIn('id', ids)}`, [nowIso(), user.id]);
    } else {
      await run(req.db, 'UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0', [nowIso(), user.id]);
    }
    res.status(204).end();
  });
  return r;
}
