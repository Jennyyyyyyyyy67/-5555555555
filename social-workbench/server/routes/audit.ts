import { Router, type Request, type Response } from 'express';
import { all, parseJson, sqlIn } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { badRequest } from '../lib/errors';
import type { AuditLogEntry } from '../../shared/types';

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
  r.get('/recent', requirePermission('viewAuditLogs'), (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const limit = parseLimit(req.query.limit);
    const where = scope.isAdmin ? '1 = 1' : `(${sqlIn('a.brand_id', scope.brandIds)} OR a.actor_user_id = :self)`;
    const rows = all<AuditRow>(
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

  return r;
}
