import { Router, type Request, type Response } from 'express';
import { all, parseJson, sqlIn } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { badRequest } from '../lib/errors';
import { resolveBrandFilter } from '../auth/scope';
import { dayStart } from '../services/analytics';
import type { AuditLogEntry, AuditQueryResponse } from '../../shared/types';

/** 操作類別 → 動作代碼條件 */
export const AUDIT_GROUPS: Record<string, string[]> = {
  reply: ['comment.reply', 'comment.auto_reply', 'comment.auto_reply_failed'],
  status: ['comment.status_change', 'comment.follow_up_received', 'comment.lock_expired', 'comment.follow_up%'],
  assign: ['comment.assign', 'comment.transfer', 'comment.force_human', 'comment.lock%', 'comment.unlock%'],
  ai: ['ai.%', 'comment.analyze', 'comment.reclassify', 'comment.auto_blocked'],
  moderation: ['comment.hide', 'comment.unhide', 'comment.delete', 'comment.block%', 'comment.like', 'comment.auto_like', 'comment.action%'],
  settings: ['automation.%', 'brand.%', 'account.%', 'user.%', 'knowledge.%', 'style.%', 'category.%', 'integration.%', 'anomaly.%', 'mock.%'],
  auth: ['auth.%'],
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface AuditRow {
  id: number;
  brand_id: number | null;
  brand_name: string | null;
  comment_id: number | null;
  actor_type: AuditLogEntry['actorType'];
  actor_user_id: number | null;
  actor_name: string | null;
  rule_id: number | null;
  action: string;
  target_type: string | null;
  target_id: number | null;
  summary: string;
  before: string | null;
  after: string | null;
  detail: string | null;
  created_at: string;
}

function toEntry(r: AuditRow): AuditLogEntry {
  return {
    id: r.id,
    brandId: r.brand_id,
    brandName: r.brand_name,
    commentId: r.comment_id,
    actorType: r.actor_type,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    ruleId: r.rule_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    summary: r.summary,
    before: parseJson<unknown>(r.before, null),
    after: parseJson<unknown>(r.after, null),
    detail: parseJson<unknown>(r.detail, null),
    createdAt: r.created_at,
  };
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  const s = typeof raw === 'string' ? raw.trim() : '';
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < 1) throw badRequest('「筆數」參數需為 1 以上的整數');
  return Math.min(n, MAX_LIMIT);
}

export function auditRoutes(): Router {
  const r = Router();

  // 最近的操作紀錄。管理員：全部；主管：負責品牌的紀錄 + 自己的操作
  r.get('/recent', requirePermission('viewAuditLogs'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const limit = parseLimit(req.query.limit);
    const where = scope.isAdmin ? '1 = 1' : `(${sqlIn('a.brand_id', scope.brandIds)} OR a.actor_user_id = :self)`;
    const rows = await all<AuditRow>(
      req.db,
      `SELECT a.id, a.brand_id, b.name AS brand_name, a.comment_id, a.actor_type, a.actor_user_id, u.name AS actor_name,
         a.rule_id, a.action, a.target_type, a.target_id, a.summary, a.before, a.after, a.detail, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
       LEFT JOIN brands b ON b.id = a.brand_id
       WHERE ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT :limit`,
      scope.isAdmin ? { limit } : { limit, self: user.id },
    );
    res.json(rows.map(toEntry));
  });

  // 操作紀錄查詢：依品牌、執行者、類別、留言、日期、關鍵字篩選
  r.get('/', requirePermission('viewAuditLogs'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const q = req.query;
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (q.brand !== undefined && q.brand !== '' && q.brand !== 'all') {
      const ids = resolveBrandFilter(scope, q.brand, 'all');
      where.push(sqlIn('a.brand_id', ids));
    } else if (!scope.isAdmin) {
      where.push(`(${sqlIn('a.brand_id', scope.brandIds)} OR a.actor_user_id = :self)`);
      params.self = user.id;
    }
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const actorType = str(q.actorType);
    if (actorType) {
      if (!['user', 'ai', 'rule', 'system'].includes(actorType)) throw badRequest('執行者類型不正確');
      where.push('a.actor_type = :actorType');
      params.actorType = actorType;
    }
    const userId = str(q.userId);
    if (userId) {
      if (!/^\d+$/.test(userId)) throw badRequest('人員參數不正確');
      where.push('a.actor_user_id = :userId');
      params.userId = Number(userId);
    }
    const group = str(q.group);
    if (group) {
      const pats = AUDIT_GROUPS[group];
      if (!pats) throw badRequest('操作類別不正確');
      where.push(`(${pats.map((_, i) => `a.action LIKE :g${i}`).join(' OR ')})`);
      pats.forEach((p, i) => (params[`g${i}`] = p));
    }
    const commentId = str(q.commentId);
    if (commentId) {
      if (!/^\d+$/.test(commentId)) throw badRequest('留言編號需為數字');
      where.push('a.comment_id = :commentId');
      params.commentId = Number(commentId);
    }
    for (const [k, op, add] of [['from', '>=', 0], ['to', '<', 86_400_000]] as const) {
      const d = str(q[k]);
      if (!d) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw badRequest('日期格式需為 YYYY-MM-DD');
      where.push(`a.created_at ${op} :${k}`);
      params[k] = new Date(dayStart(d) + add).toISOString();
    }
    const kw = str(q.q);
    if (kw) {
      where.push('(a.summary ILIKE :kw OR u.name ILIKE :kw)');
      params.kw = `%${kw.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    }
    const pageSize = Math.min(Math.max(Number(q.pageSize) || 30, 1), MAX_LIMIT);
    const page = Math.max(Number(q.page) || 1, 1);
    const cond = where.length ? where.join(' AND ') : '1 = 1';
    const from = `FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN brands b ON b.id = a.brand_id WHERE ${cond}`;
    const total = Number((await all<{ n: number }>(req.db, `SELECT COUNT(*) AS n ${from}`, params))[0]?.n ?? 0);
    const rows = await all<AuditRow>(
      req.db,
      `SELECT a.id, a.brand_id, b.name AS brand_name, a.comment_id, a.actor_type, a.actor_user_id, u.name AS actor_name,
         a.rule_id, a.action, a.target_type, a.target_id, a.summary, a.before, a.after, a.detail, a.created_at
       ${from} ORDER BY a.created_at DESC, a.id DESC LIMIT :limit OFFSET :offset`,
      { ...params, limit: pageSize, offset: (page - 1) * pageSize },
    );
    const items: AuditQueryResponse['items'] = rows.map(toEntry);
    // 回覆紀錄附上實際送出的內容與原始 AI 建議，方便比對人工是否修改
    const replyIds = items.map((i) => (i.detail as { replyId?: number } | null)?.replyId).filter((x): x is number => typeof x === 'number');
    if (replyIds.length) {
      const replies = await all<{ id: number; body: string; ai_original_body: string | null; source: string }>(
        req.db,
        `SELECT id, body, ai_original_body, source FROM replies WHERE ${sqlIn('id', replyIds)}`,
      );
      for (const it of items) {
        const rid = (it.detail as { replyId?: number } | null)?.replyId;
        const rp = replies.find((x) => x.id === rid);
        if (rp) Object.assign(it, { replyBody: rp.body, aiOriginalBody: rp.ai_original_body, replySource: rp.source });
      }
    }
    res.json({ items, total, page, pageSize } satisfies AuditQueryResponse);
  });

  return r;
}
