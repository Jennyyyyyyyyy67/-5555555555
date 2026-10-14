// 知識庫：品牌知識的新增、修改、審核、停用與版本紀錄。AI 回覆建議只會引用「已審核、啟用、有效期限內」的知識。
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { all, get, insert, parseJson, sqlIn, tx, updateById, type DB } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { resolveBrandFilter } from '../auth/scope';
import { audit } from '../services/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { can } from '../../shared/permissions';
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_CATEGORY_LABELS, type KnowledgeCategory } from '../../shared/constants';
import type { KnowledgeDetailResponse, KnowledgeItem, KnowledgeListResponse, KnowledgeRevision, KnowledgeSearchResult } from '../../shared/types';
import { searchKnowledge, validState } from '../ai/knowledge';
import { mockProvider } from '../ai/mockProvider';

interface Row {
  id: number;
  brand_id: number;
  brand_name: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  keywords: string;
  is_active: number;
  valid_from: string | null;
  valid_to: string | null;
  review_status: KnowledgeItem['reviewStatus'];
  source: KnowledgeItem['source'];
  source_comment_id: number | null;
  version: number;
  created_by_id: number | null;
  created_by_name: string | null;
  updated_by_name: string | null;
  approved_by_name: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `
  SELECT k.*, b.name AS brand_name, cu.name AS created_by_name, uu.name AS updated_by_name, au.name AS approved_by_name
  FROM knowledge_items k JOIN brands b ON b.id = k.brand_id
  LEFT JOIN users cu ON cu.id = k.created_by_id LEFT JOIN users uu ON uu.id = k.updated_by_id LEFT JOIN users au ON au.id = k.approved_by_id`;

function toItem(r: Row): KnowledgeItem {
  const state = validState(r.valid_from, r.valid_to);
  return {
    id: r.id,
    brandId: r.brand_id,
    brandName: r.brand_name,
    category: r.category,
    title: r.title,
    content: r.content,
    keywords: parseJson<string[]>(r.keywords, []),
    isActive: r.is_active === 1,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    reviewStatus: r.review_status,
    source: r.source,
    sourceCommentId: r.source_comment_id,
    version: r.version,
    createdByName: r.created_by_name,
    updatedByName: r.updated_by_name,
    approvedByName: r.approved_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    isExpired: state === 'expired',
    isUpcoming: state === 'upcoming',
  };
}

const dateField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式需為 YYYY-MM-DD')
  .nullable()
  .optional()
  .transform((v) => v || null);

const fields = {
  category: z.enum(KNOWLEDGE_CATEGORIES, { errorMap: () => ({ message: '請選擇知識分類' }) }),
  title: z.string().trim().min(1, '請輸入標題').max(60, '標題最多 60 個字'),
  content: z.string().trim().min(1, '請輸入內容').max(2000, '內容最多 2000 個字'),
  keywords: z
    .array(z.string().trim().min(1).max(30, '每個關鍵字最多 30 個字'))
    .min(1, '請至少輸入一個關鍵字（留言包含關鍵字時，AI 才會找到這則知識）')
    .max(30, '關鍵字最多 30 個'),
  validFrom: dateField,
  validTo: dateField,
};
const createSchema = z.object({ brandId: z.number().int().positive('請選擇品牌'), ...fields, sourceCommentId: z.number().int().positive().nullable().optional() });
const patchSchema = z.object(fields).partial().extend({ note: z.string().trim().max(200).optional() });

function checkDates(from: string | null | undefined, to: string | null | undefined) {
  if (from && to && from > to) throw badRequest('開始日期不能晚於結束日期', { field: 'validTo' });
}

async function loadOne(db: DB, brandIds: number[], id: number): Promise<Row> {
  const row = Number.isSafeInteger(id) ? await get<Row>(db, `${SELECT} WHERE k.id = ? AND ${sqlIn('k.brand_id', brandIds)}`, [id]) : undefined;
  if (!row) throw notFound('找不到這則知識');
  return row;
}

async function addRevision(db: DB, r: { id: number; brandId: number; version: number; changeType: string; snapshot: unknown; note?: string; userId: number }) {
  await insert(db, 'knowledge_revisions', {
    knowledge_id: r.id,
    brand_id: r.brandId,
    version: r.version,
    change_type: r.changeType,
    snapshot: r.snapshot,
    note: r.note ?? '',
    changed_by_id: r.userId,
    created_at: nowIso(),
  });
}

const snapshotOf = (x: { title: string; content: string; keywords: string[]; category: string; validFrom: string | null; validTo: string | null }) => ({
  title: x.title,
  content: x.content,
  keywords: x.keywords,
  category: x.category,
  validFrom: x.validFrom,
  validTo: x.validTo,
});

export function knowledgeRoutes(): Router {
  const r = Router();

  r.get('/', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand);
    if (brandIds.length === 0) return res.json({ items: [], counts: { all: 0, approved: 0, pending: 0, rejected: 0, expired: 0, inactive: 0 } } satisfies KnowledgeListResponse);
    const rows = await all<Row>(db(req), `${SELECT} WHERE ${sqlIn('k.brand_id', brandIds)} ORDER BY k.updated_at DESC, k.id DESC`);
    let items = rows.map(toItem);
    const counts = {
      all: items.length,
      approved: items.filter((i) => i.reviewStatus === 'approved' && i.isActive && !i.isExpired).length,
      pending: items.filter((i) => i.reviewStatus === 'pending').length,
      rejected: items.filter((i) => i.reviewStatus === 'rejected').length,
      expired: items.filter((i) => i.isExpired).length,
      inactive: items.filter((i) => !i.isActive).length,
    };
    const status = String(req.query.status ?? '');
    if (status === 'approved') items = items.filter((i) => i.reviewStatus === 'approved' && i.isActive && !i.isExpired);
    else if (status === 'pending' || status === 'rejected') items = items.filter((i) => i.reviewStatus === status);
    else if (status === 'expired') items = items.filter((i) => i.isExpired);
    else if (status === 'inactive') items = items.filter((i) => !i.isActive);
    const category = String(req.query.category ?? '');
    if (category) items = items.filter((i) => i.category === category);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (q) items = items.filter((i) => `${i.title}\n${i.content}\n${i.keywords.join(' ')}`.toLowerCase().includes(q));
    res.json({ items, counts } satisfies KnowledgeListResponse);
  });

  r.get('/:id', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const row = await loadOne(db(req), scope.brandIds, Number(req.params.id));
    const revisions = await all<{ id: number; version: number; change_type: string; snapshot: string; note: string; changed_by_name: string | null; created_at: string }>(
      db(req),
      `SELECT r.id, r.version, r.change_type, r.snapshot, r.note, u.name AS changed_by_name, r.created_at
       FROM knowledge_revisions r LEFT JOIN users u ON u.id = r.changed_by_id WHERE r.knowledge_id = ? ORDER BY r.id DESC`,
      [row.id],
    );
    const body: KnowledgeDetailResponse = {
      item: toItem(row),
      revisions: revisions.map(
        (v): KnowledgeRevision => ({
          id: v.id,
          version: v.version,
          changeType: v.change_type,
          snapshot: parseJson(v.snapshot, { title: '', content: '', keywords: [], category: 'other', validFrom: null, validTo: null }),
          note: v.note,
          changedByName: v.changed_by_name,
          createdAt: v.created_at,
        }),
      ),
    };
    res.json(body);
  });

  // 新增：主管、管理員直接生效；小編提出的知識需等待審核
  r.post('/', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = createSchema.parse(req.body);
    if (!scope.activeBrandIds.includes(input.brandId)) throw notFound('找不到品牌');
    checkDates(input.validFrom, input.validTo);
    const approver = can(user.role, 'approveKnowledge');
    const now = nowIso();
    const id = await tx(db(req), async () => {
      const id = await insert(db(req), 'knowledge_items', {
        brand_id: input.brandId,
        category: input.category,
        title: input.title,
        content: input.content,
        keywords: [...new Set(input.keywords)],
        is_active: true,
        valid_from: input.validFrom,
        valid_to: input.validTo,
        review_status: approver ? 'approved' : 'pending',
        source: input.sourceCommentId ? 'from_reply' : 'manual',
        source_comment_id: input.sourceCommentId ?? null,
        version: 1,
        created_by_id: user.id,
        updated_by_id: user.id,
        approved_by_id: approver ? user.id : null,
        created_at: now,
        updated_at: now,
      });
      await addRevision(db(req), { id, brandId: input.brandId, version: 1, changeType: approver ? 'create' : 'propose', snapshot: snapshotOf(input), userId: user.id });
      await audit(db(req), {
        actorType: 'user',
        actorUserId: user.id,
        brandId: input.brandId,
        action: approver ? 'knowledge.create' : 'knowledge.propose',
        targetType: 'knowledge',
        targetId: id,
        summary: approver ? `${user.name} 新增知識「${input.title}」` : `${user.name} 提出知識「${input.title}」，等待審核`,
        after: snapshotOf(input),
      });
      return id;
    });
    res.status(201).json(toItem(await loadOne(db(req), scope.brandIds, id)));
  });

  // 修改：主管、管理員可改任何知識；小編只能改自己提出、尚未通過的知識
  r.patch('/:id', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const row = await loadOne(db(req), scope.brandIds, Number(req.params.id));
    const approver = can(user.role, 'approveKnowledge');
    const ownPending = row.review_status !== 'approved' && row.created_by_id === user.id;
    if (!approver && !ownPending) throw forbidden('只有主管或管理員可以修改已審核的知識；你可以新增一則知識提出修改建議');
    const input = patchSchema.parse(req.body);
    const cur = toItem(row);
    const next = { ...snapshotOf(cur), ...Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && k !== 'note')) } as ReturnType<typeof snapshotOf>;
    checkDates(next.validFrom, next.validTo);
    const version = row.version + 1;
    await tx(db(req), async () => {
      await updateById(db(req), 'knowledge_items', row.id, {
        category: next.category,
        title: next.title,
        content: next.content,
        keywords: [...new Set(next.keywords)],
        valid_from: next.validFrom,
        valid_to: next.validTo,
        version,
        // 小編修改後仍需審核；被退回的知識修改後重新送審
        review_status: approver ? row.review_status : 'pending',
        updated_by_id: user.id,
        updated_at: nowIso(),
      });
      await addRevision(db(req), { id: row.id, brandId: row.brand_id, version, changeType: 'update', snapshot: next, note: input.note, userId: user.id });
      await audit(db(req), {
        actorType: 'user',
        actorUserId: user.id,
        brandId: row.brand_id,
        action: 'knowledge.update',
        targetType: 'knowledge',
        targetId: row.id,
        summary: `${user.name} 修改知識「${next.title}」（第 ${version} 版）${input.note ? `：${input.note}` : ''}`,
        before: snapshotOf(cur),
        after: next,
      });
    });
    res.json(toItem(await loadOne(db(req), scope.brandIds, row.id)));
  });

  // 審核
  r.post('/:id/review', requirePermission('approveKnowledge'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const row = await loadOne(db(req), scope.brandIds, Number(req.params.id));
    const { decision, note } = z
      .object({ decision: z.enum(['approve', 'reject'], { errorMap: () => ({ message: '請選擇通過或退回' }) }), note: z.string().trim().max(200).optional() })
      .parse(req.body);
    if (decision === 'reject' && !note) throw badRequest('退回時請填寫原因，讓提出的人知道要怎麼修改', { field: 'note' });
    await tx(db(req), async () => {
      await updateById(db(req), 'knowledge_items', row.id, {
        review_status: decision === 'approve' ? 'approved' : 'rejected',
        approved_by_id: decision === 'approve' ? user.id : null,
        updated_at: nowIso(),
      });
      await addRevision(db(req), { id: row.id, brandId: row.brand_id, version: row.version, changeType: decision, snapshot: snapshotOf(toItem(row)), note, userId: user.id });
      await audit(db(req), {
        actorType: 'user',
        actorUserId: user.id,
        brandId: row.brand_id,
        action: decision === 'approve' ? 'knowledge.approve' : 'knowledge.reject',
        targetType: 'knowledge',
        targetId: row.id,
        summary: decision === 'approve' ? `${user.name} 審核通過知識「${row.title}」` : `${user.name} 退回知識「${row.title}」：${note}`,
      });
    });
    res.json(toItem(await loadOne(db(req), scope.brandIds, row.id)));
  });

  // 啟用／停用
  r.post('/:id/active', requirePermission('approveKnowledge'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const row = await loadOne(db(req), scope.brandIds, Number(req.params.id));
    const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
    if ((row.is_active === 1) !== isActive) {
      await tx(db(req), async () => {
        await updateById(db(req), 'knowledge_items', row.id, { is_active: isActive, updated_by_id: user.id, updated_at: nowIso() });
        await addRevision(db(req), { id: row.id, brandId: row.brand_id, version: row.version, changeType: isActive ? 'activate' : 'deactivate', snapshot: snapshotOf(toItem(row)), userId: user.id });
        await audit(db(req), {
          actorType: 'user',
          actorUserId: user.id,
          brandId: row.brand_id,
          action: isActive ? 'knowledge.activate' : 'knowledge.deactivate',
          targetType: 'knowledge',
          targetId: row.id,
          summary: `${user.name} ${isActive ? '啟用' : '停用'}知識「${row.title}」`,
        });
      });
    }
    res.json(toItem(await loadOne(db(req), scope.brandIds, row.id)));
  });

  // 試搜尋：輸入一則留言，看 AI 會引用哪些知識
  r.post('/search', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const input = z.object({ brandId: z.number().int().positive(), body: z.string().trim().min(1, '請輸入留言內容').max(1000) }).parse(req.body);
    if (!scope.brandIds.includes(input.brandId)) throw notFound('找不到品牌');
    const brand = await get<{ code: string }>(db(req), 'SELECT code FROM brands WHERE id = ?', [input.brandId]);
    const a = await mockProvider.analyze({ body: input.body, authorName: '', rating: null, platform: 'facebook', brandCode: brand?.code ?? '' });
    const cat = await get<{ name: string }>(db(req), 'SELECT name FROM comment_categories WHERE key = ?', [a.categoryKey]);
    const result: KnowledgeSearchResult = await searchKnowledge(db(req), { brandId: input.brandId, body: input.body, categoryKey: a.categoryKey, categoryName: cat?.name ?? a.categoryKey });
    res.json(result);
  });

  return r;
}

const db = (req: Request) => req.db;

export const KNOWLEDGE_META = KNOWLEDGE_CATEGORIES.map((key) => ({ key, label: KNOWLEDGE_CATEGORY_LABELS[key] }));
