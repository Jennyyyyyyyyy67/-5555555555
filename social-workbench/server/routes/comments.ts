import { Router, type Request, type Response } from 'express';
import { all, bool, get, parseJson, sqlIn } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { resolveBrandFilter } from '../auth/scope';
import { badRequest } from '../lib/errors';
import {
  COMMENT_STATUSES,
  STATUS_LABELS,
  type CommentStatus,
  type ContentType,
  type HandlingMode,
  type Priority,
  type RiskFlag,
  type RiskLevel,
  type Sentiment,
  type Visibility,
} from '../../shared/constants';
import type { CommentPreview, Paginated } from '../../shared/types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_QUERY_LENGTH = 100;

/** 取出單一字串查詢參數；重複帶入同一個參數（陣列）視為格式錯誤 */
function queryString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw badRequest(`「${label}」參數只能帶一個值，請重新選擇篩選條件`);
  const s = value.trim();
  return s === '' ? undefined : s;
}

function queryInt(value: unknown, label: string, opts: { min: number; fallback: number }): number {
  const s = queryString(value, label);
  if (s === undefined) return opts.fallback;
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < opts.min) {
    throw badRequest(`「${label}」參數需為 ${opts.min} 以上的整數`);
  }
  return n;
}

/** LIKE 搜尋用：跳脫 \ % _，搭配 ESCAPE '\' */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

interface PreviewRow {
  id: number;
  brand_id: number;
  brand_name: string;
  brand_color: string;
  platform: string;
  account_id: number;
  account_name: string;
  account_type: string;
  post_id: number;
  post_title: string;
  content_type: ContentType;
  is_ad: number;
  parent_comment_id: number | null;
  author_name: string;
  body: string;
  rating: number | null;
  occurred_at: string;
  fetched_at: string;
  status: CommentStatus;
  priority: Priority | null;
  category_key: string | null;
  category_name: string | null;
  tags: string;
  risk_flags: string;
  risk_level: RiskLevel | null;
  sentiment: Sentiment | null;
  handling_mode: HandlingMode | null;
  assignee_id: number | null;
  assignee_name: string | null;
  sla_due_at: string | null;
  first_response_at: string | null;
  completed_at: string | null;
  visibility: Visibility;
}

function toPreview(r: PreviewRow): CommentPreview {
  return {
    id: r.id,
    brandId: r.brand_id,
    brandName: r.brand_name,
    brandColor: r.brand_color,
    platform: r.platform,
    accountId: r.account_id,
    accountName: r.account_name,
    accountType: r.account_type,
    postId: r.post_id,
    postTitle: r.post_title,
    contentType: r.content_type,
    isAd: bool(r.is_ad),
    parentCommentId: r.parent_comment_id,
    authorName: r.author_name,
    body: r.body,
    rating: r.rating,
    occurredAt: r.occurred_at,
    fetchedAt: r.fetched_at,
    status: r.status,
    priority: r.priority,
    categoryKey: r.category_key,
    categoryName: r.category_name,
    tags: parseJson<string[]>(r.tags, []),
    riskFlags: parseJson<RiskFlag[]>(r.risk_flags, []),
    riskLevel: r.risk_level,
    sentiment: r.sentiment,
    handlingMode: r.handling_mode,
    assigneeId: r.assignee_id,
    assigneeName: r.assignee_name,
    slaDueAt: r.sla_due_at,
    firstResponseAt: r.first_response_at,
    completedAt: r.completed_at,
    visibility: r.visibility,
  };
}

export function commentRoutes(): Router {
  const r = Router();

  // 階段 1 收件匣預覽：依品牌範圍列出留言（只含啟用中的品牌）
  r.get('/preview', requirePermission('handleComments'), (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand).filter((id) => scope.activeBrandIds.includes(id));

    const platform = queryString(req.query.platform, '平台');
    const status = queryString(req.query.status, '狀態');
    if (status !== undefined && !(COMMENT_STATUSES as readonly string[]).includes(status)) {
      const options = COMMENT_STATUSES.map((s) => STATUS_LABELS[s]).join('、');
      throw badRequest(`留言狀態參數不正確，可選擇：${options}`);
    }
    const accountRaw = queryString(req.query.accountId, '社群帳號');
    let accountId: number | undefined;
    if (accountRaw !== undefined) {
      accountId = Number(accountRaw);
      if (!/^\d+$/.test(accountRaw) || !Number.isSafeInteger(accountId) || accountId <= 0) {
        throw badRequest('社群帳號參數不正確，請重新選擇帳號');
      }
    }
    const q = queryString(req.query.q, '搜尋');
    if (q !== undefined && q.length > MAX_QUERY_LENGTH) {
      throw badRequest(`搜尋文字最多 ${MAX_QUERY_LENGTH} 個字，請縮短後再搜尋`);
    }
    const limit = Math.min(queryInt(req.query.limit, '每頁筆數', { min: 1, fallback: DEFAULT_LIMIT }), MAX_LIMIT);
    const offset = queryInt(req.query.offset, '起始位置', { min: 0, fallback: 0 });

    // 品牌過濾一律放第一個條件；帳號只會在可存取品牌內比對，其他品牌的帳號自然查不到資料
    const where = [sqlIn('c.brand_id', brandIds)];
    const params: Record<string, unknown> = {};
    if (platform !== undefined) {
      where.push('sa.platform = :platform');
      params.platform = platform;
    }
    if (status !== undefined) {
      where.push('c.status = :status');
      params.status = status;
    }
    if (accountId !== undefined) {
      where.push('c.social_account_id = :accountId');
      params.accountId = accountId;
    }
    if (q !== undefined) {
      where.push("(c.body LIKE :q ESCAPE '\\' OR c.author_name LIKE :q ESCAPE '\\')");
      params.q = likePattern(q);
    }
    const whereSql = where.join(' AND ');

    const total =
      get<{ n: number }>(
        req.db,
        `SELECT COUNT(*) AS n FROM comments c JOIN social_accounts sa ON sa.id = c.social_account_id WHERE ${whereSql}`,
        params,
      )?.n ?? 0;

    const rows = all<PreviewRow>(
      req.db,
      `SELECT c.id, c.brand_id, b.name AS brand_name, b.color AS brand_color,
         sa.platform, sa.id AS account_id, sa.name AS account_name, sa.account_type,
         p.id AS post_id, p.title AS post_title, p.content_type, p.is_ad,
         c.parent_comment_id, c.author_name, c.body, c.rating, c.occurred_at, c.fetched_at,
         c.status, c.priority, cc.key AS category_key, cc.name AS category_name,
         c.tags, c.risk_flags, c.risk_level, c.sentiment, c.handling_mode,
         c.assignee_id, u.name AS assignee_name,
         c.sla_due_at, c.first_response_at, c.completed_at, c.visibility
       FROM comments c
       JOIN brands b ON b.id = c.brand_id
       JOIN social_accounts sa ON sa.id = c.social_account_id
       JOIN posts p ON p.id = c.post_id
       LEFT JOIN comment_categories cc ON cc.id = c.category_id
       LEFT JOIN users u ON u.id = c.assignee_id
       WHERE ${whereSql}
       ORDER BY c.occurred_at DESC, c.id DESC
       LIMIT :limit OFFSET :offset`,
      { ...params, limit, offset },
    );

    const body: Paginated<CommentPreview> = { items: rows.map(toPreview), total, limit, offset };
    res.json(body);
  });

  return r;
}
