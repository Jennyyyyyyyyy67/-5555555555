// 回覆素材：標準回覆（小編可直接套用）與回覆範例（AI 參考品牌習慣；員工的好回覆經主管審核後才收錄）。
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { all, get, insert, sqlIn, tx, updateById, type DB } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { resolveBrandFilter } from '../auth/scope';
import { audit, diffFields } from '../services/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { can } from '../../shared/permissions';
import type { CannedReply, ReplyExample, ReplyExampleListResponse, ReplyExampleStatus } from '../../shared/types';

async function assertCategory(db: DB, categoryId: number | null) {
  if (categoryId !== null && !(await get(db, 'SELECT id FROM comment_categories WHERE id = ?', [categoryId]))) throw badRequest('留言類型不存在', { field: 'categoryId' });
}

// ---------------- 標準回覆 ----------------
interface CannedRow {
  id: number;
  brand_id: number;
  brand_name: string;
  category_id: number | null;
  category_name: string | null;
  title: string;
  body: string;
  is_active: number;
  created_by_name: string | null;
  updated_at: string;
}

const CANNED_SELECT = `
  SELECT cr.*, b.name AS brand_name, cc.name AS category_name, u.name AS created_by_name
  FROM canned_replies cr JOIN brands b ON b.id = cr.brand_id
  LEFT JOIN comment_categories cc ON cc.id = cr.category_id LEFT JOIN users u ON u.id = cr.created_by_id`;

const toCanned = (r: CannedRow): CannedReply => ({
  id: r.id,
  brandId: r.brand_id,
  brandName: r.brand_name,
  categoryId: r.category_id,
  categoryName: r.category_name,
  title: r.title,
  body: r.body,
  isActive: r.is_active === 1,
  createdByName: r.created_by_name,
  updatedAt: r.updated_at,
});

const cannedFields = {
  categoryId: z.number().int().positive().nullable(),
  title: z.string().trim().min(1, '請輸入名稱').max(40, '名稱最多 40 個字'),
  body: z.string().trim().min(1, '請輸入回覆內容').max(2000, '回覆最多 2000 個字'),
};

/** 讀取一則標準回覆（送出回覆時用來確認來源） */
export async function loadCanned(db: DB, brandIds: number[], id: number): Promise<CannedReply> {
  const row = Number.isSafeInteger(id) ? await get<CannedRow>(db, `${CANNED_SELECT} WHERE cr.id = ? AND ${sqlIn('cr.brand_id', brandIds)}`, [id]) : undefined;
  if (!row) throw notFound('找不到這則標準回覆');
  return toCanned(row);
}

export function cannedReplyRoutes(): Router {
  const r = Router();

  r.get('/', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand);
    if (brandIds.length === 0) return res.json([]);
    const onlyActive = req.query.active === '1';
    const rows = await all<CannedRow>(
      req.db,
      `${CANNED_SELECT} WHERE ${sqlIn('cr.brand_id', brandIds)}${onlyActive ? ' AND cr.is_active = 1' : ''} ORDER BY cr.is_active DESC, cc.sort_order NULLS FIRST, cr.title`,
    );
    res.json(rows.map(toCanned));
  });

  r.post('/', requirePermission('approveKnowledge'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = z.object({ brandId: z.number().int().positive('請選擇品牌'), ...cannedFields }).parse(req.body);
    if (!scope.activeBrandIds.includes(input.brandId)) throw notFound('找不到品牌');
    await assertCategory(req.db, input.categoryId);
    const now = nowIso();
    const id = await tx(req.db, async () => {
      const id = await insert(req.db, 'canned_replies', {
        brand_id: input.brandId,
        category_id: input.categoryId,
        title: input.title,
        body: input.body,
        is_active: true,
        created_by_id: user.id,
        created_at: now,
        updated_at: now,
      });
      await audit(req.db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: input.brandId,
        action: 'canned.create',
        targetType: 'canned_reply',
        targetId: id,
        summary: `${user.name} 新增標準回覆「${input.title}」`,
        after: input,
      });
      return id;
    });
    res.status(201).json(await loadCanned(req.db, scope.brandIds, id));
  });

  r.patch('/:id', requirePermission('approveKnowledge'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const cur = await loadCanned(req.db, scope.brandIds, Number(req.params.id));
    const input = z.object(cannedFields).partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
    if (input.categoryId !== undefined) await assertCategory(req.db, input.categoryId);
    const diff = diffFields({ categoryId: cur.categoryId, title: cur.title, body: cur.body, isActive: cur.isActive }, input);
    if (diff) {
      await tx(req.db, async () => {
        await updateById(req.db, 'canned_replies', cur.id, {
          category_id: input.categoryId,
          title: input.title,
          body: input.body,
          is_active: input.isActive,
          updated_at: nowIso(),
        });
        await audit(req.db, {
          actorType: 'user',
          actorUserId: user.id,
          brandId: cur.brandId,
          action: input.isActive === false ? 'canned.deactivate' : 'canned.update',
          targetType: 'canned_reply',
          targetId: cur.id,
          summary: input.isActive === false ? `${user.name} 停用標準回覆「${cur.title}」` : `${user.name} 修改標準回覆「${input.title ?? cur.title}」`,
          before: diff.before,
          after: diff.after,
        });
      });
    }
    res.json(await loadCanned(req.db, scope.brandIds, cur.id));
  });

  return r;
}

// ---------------- 回覆範例 ----------------
interface ExampleRow {
  id: number;
  brand_id: number;
  brand_name: string;
  category_id: number | null;
  category_name: string | null;
  scenario: string;
  sample_comment: string;
  good_reply: string;
  bad_reply: string;
  notes: string;
  status: ReplyExampleStatus;
  source: ReplyExample['source'];
  source_reply_id: number | null;
  submitted_by_id: number | null;
  submitted_by_name: string | null;
  approved_by_name: string | null;
  created_at: string;
  updated_at: string;
}

const EXAMPLE_SELECT = `
  SELECT e.*, b.name AS brand_name, cc.name AS category_name, su.name AS submitted_by_name, au.name AS approved_by_name
  FROM reply_examples e JOIN brands b ON b.id = e.brand_id
  LEFT JOIN comment_categories cc ON cc.id = e.category_id
  LEFT JOIN users su ON su.id = e.submitted_by_id LEFT JOIN users au ON au.id = e.approved_by_id`;

const toExample = (r: ExampleRow): ReplyExample => ({
  id: r.id,
  brandId: r.brand_id,
  brandName: r.brand_name,
  categoryId: r.category_id,
  categoryName: r.category_name,
  scenario: r.scenario,
  sampleComment: r.sample_comment,
  goodReply: r.good_reply,
  badReply: r.bad_reply,
  notes: r.notes,
  status: r.status,
  source: r.source,
  sourceReplyId: r.source_reply_id,
  submittedByName: r.submitted_by_name,
  approvedByName: r.approved_by_name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const exampleFields = {
  categoryId: z.number().int().positive().nullable(),
  scenario: z.string().trim().max(100, '適用情境最多 100 個字').default(''),
  sampleComment: z.string().trim().min(1, '請輸入範例留言').max(1000, '範例留言最多 1000 個字'),
  goodReply: z.string().trim().min(1, '請輸入建議的回覆').max(2000, '建議的回覆最多 2000 個字'),
  badReply: z.string().trim().max(2000, '不建議的回覆最多 2000 個字').default(''),
  notes: z.string().trim().max(300, '說明最多 300 個字').default(''),
};

async function loadExample(db: DB, brandIds: number[], id: number): Promise<ExampleRow> {
  const row = Number.isSafeInteger(id) ? await get<ExampleRow>(db, `${EXAMPLE_SELECT} WHERE e.id = ? AND ${sqlIn('e.brand_id', brandIds)}`, [id]) : undefined;
  if (!row) throw notFound('找不到這則回覆範例');
  return row;
}

/** AI 產生回覆時參考的範例：同品牌、啟用中，優先同類型，其次不限類型 */
export async function examplesFor(db: DB, brandId: number, categoryId: number | null, limit = 4): Promise<ReplyExample[]> {
  const rows = await all<ExampleRow>(
    db,
    `${EXAMPLE_SELECT} WHERE e.brand_id = ? AND e.status = 'active' AND (e.category_id IS NULL OR e.category_id = ?)
     ORDER BY CASE WHEN e.category_id = ? THEN 0 ELSE 1 END, e.updated_at DESC LIMIT ${Number(limit)}`,
    [brandId, categoryId ?? -1, categoryId ?? -1],
  );
  return rows.map(toExample);
}

export function replyExampleRoutes(): Router {
  const r = Router();

  r.get('/', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand);
    const empty = { all: 0, active: 0, pending: 0, rejected: 0, inactive: 0 };
    if (brandIds.length === 0) return res.json({ items: [], counts: empty } satisfies ReplyExampleListResponse);
    const rows = (await all<ExampleRow>(req.db, `${EXAMPLE_SELECT} WHERE ${sqlIn('e.brand_id', brandIds)} ORDER BY e.updated_at DESC, e.id DESC`)).map(toExample);
    const counts = { ...empty, all: rows.length };
    for (const x of rows) counts[x.status]++;
    const status = typeof req.query.status === 'string' && req.query.status in empty ? (req.query.status as ReplyExampleStatus) : null;
    res.json({ items: status ? rows.filter((x) => x.status === status) : rows, counts } satisfies ReplyExampleListResponse);
  });

  const createSchema = z.object({ brandId: z.number().int().positive('請選擇品牌'), ...exampleFields });

  /** 新增：主管、管理員直接生效；小編提出的範例需等待審核 */
  async function create(req: Request, input: z.infer<typeof createSchema> & { sourceReplyId?: number }) {
    const { user } = authed(req);
    const approver = can(user.role, 'approveKnowledge');
    const now = nowIso();
    return tx(req.db, async () => {
      const id = await insert(req.db, 'reply_examples', {
        brand_id: input.brandId,
        category_id: input.categoryId,
        scenario: input.scenario,
        sample_comment: input.sampleComment,
        good_reply: input.goodReply,
        bad_reply: input.badReply,
        notes: input.notes,
        status: approver ? 'active' : 'pending',
        source: input.sourceReplyId ? 'from_reply' : 'manual',
        source_reply_id: input.sourceReplyId ?? null,
        submitted_by_id: user.id,
        approved_by_id: approver ? user.id : null,
        created_at: now,
        updated_at: now,
      });
      await audit(req.db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: input.brandId,
        action: approver ? 'example.create' : 'example.propose',
        targetType: 'reply_example',
        targetId: id,
        summary: `${user.name} ${approver ? '新增' : '提出'}回覆範例${input.sourceReplyId ? '（收錄自實際回覆）' : ''}${approver ? '' : '，等待審核'}`,
        after: input,
      });
      return id;
    });
  }
  r.post('/', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const input = createSchema.parse(req.body);
    if (!scope.activeBrandIds.includes(input.brandId)) throw notFound('找不到品牌');
    await assertCategory(req.db, input.categoryId);
    const id = await create(req, input);
    res.status(201).json(toExample(await loadExample(req.db, scope.brandIds, id)));
  });

  // 從實際送出的回覆收錄：留言與回覆自動帶入，不會自動把所有回覆都當成標準答案
  r.post('/from-reply', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const input = z
      .object({
        replyId: z.number().int().positive(),
        scenario: exampleFields.scenario,
        notes: exampleFields.notes,
        badReply: exampleFields.badReply,
        goodReply: z.string().trim().min(1, '請輸入建議的回覆').max(2000).optional(),
      })
      .parse(req.body);
    const reply = await get<{ id: number; body: string; brand_id: number; comment_body: string; category_id: number | null; delivery_status: string }>(
      req.db,
      `SELECT r.id, r.body, r.brand_id, r.delivery_status, c.body AS comment_body, c.category_id FROM replies r JOIN comments c ON c.id = r.comment_id
       WHERE r.id = ? AND ${sqlIn('r.brand_id', scope.activeBrandIds)}`,
      [input.replyId],
    );
    if (!reply || reply.delivery_status !== 'sent') throw notFound('找不到這則回覆');
    if (await get(req.db, "SELECT id FROM reply_examples WHERE source_reply_id = ? AND status <> 'rejected'", [reply.id])) throw conflict('這則回覆已經收錄（或正在審核）');
    const id = await create(req, {
      brandId: reply.brand_id,
      categoryId: reply.category_id,
      scenario: input.scenario,
      sampleComment: reply.comment_body.slice(0, 1000),
      goodReply: input.goodReply ?? reply.body,
      badReply: input.badReply,
      notes: input.notes,
      sourceReplyId: reply.id,
    });
    res.status(201).json(toExample(await loadExample(req.db, scope.brandIds, id)));
  });

  r.patch('/:id', requirePermission('approveKnowledge'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const row = await loadExample(req.db, scope.brandIds, Number(req.params.id));
    const input = z
      .object({
        categoryId: exampleFields.categoryId,
        scenario: z.string().trim().max(100),
        sampleComment: z.string().trim().min(1, '請輸入範例留言').max(1000),
        goodReply: z.string().trim().min(1, '請輸入建議的回覆').max(2000),
        badReply: z.string().trim().max(2000),
        notes: z.string().trim().max(300),
        isActive: z.boolean(),
      })
      .partial()
      .parse(req.body);
    if (input.categoryId !== undefined) await assertCategory(req.db, input.categoryId);
    const cur = toExample(row);
    if (input.isActive !== undefined && cur.status !== 'active' && cur.status !== 'inactive') throw badRequest('請先審核這則範例');
    const { isActive, ...fields } = input;
    const diff = diffFields(
      { categoryId: cur.categoryId, scenario: cur.scenario, sampleComment: cur.sampleComment, goodReply: cur.goodReply, badReply: cur.badReply, notes: cur.notes, isActive: cur.status === 'active' },
      input,
    );
    if (diff) {
      await tx(req.db, async () => {
        await updateById(req.db, 'reply_examples', row.id, {
          category_id: fields.categoryId,
          scenario: fields.scenario,
          sample_comment: fields.sampleComment,
          good_reply: fields.goodReply,
          bad_reply: fields.badReply,
          notes: fields.notes,
          status: isActive === undefined ? undefined : isActive ? 'active' : 'inactive',
          updated_at: nowIso(),
        });
        await audit(req.db, {
          actorType: 'user',
          actorUserId: user.id,
          brandId: row.brand_id,
          action: isActive === false ? 'example.deactivate' : 'example.update',
          targetType: 'reply_example',
          targetId: row.id,
          summary: isActive === false ? `${user.name} 停用回覆範例` : `${user.name} 修改回覆範例`,
          before: diff.before,
          after: diff.after,
        });
      });
    }
    res.json(toExample(await loadExample(req.db, scope.brandIds, row.id)));
  });

  r.post('/:id/review', requirePermission('approveKnowledge'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const row = await loadExample(req.db, scope.brandIds, Number(req.params.id));
    const { decision, note } = z
      .object({ decision: z.enum(['approve', 'reject'], { errorMap: () => ({ message: '請選擇通過或退回' }) }), note: z.string().trim().max(200).optional() })
      .parse(req.body);
    if (row.status !== 'pending') throw badRequest('這則範例不是待審核狀態');
    await tx(req.db, async () => {
      await updateById(req.db, 'reply_examples', row.id, {
        status: decision === 'approve' ? 'active' : 'rejected',
        approved_by_id: decision === 'approve' ? user.id : null,
        updated_at: nowIso(),
      });
      await audit(req.db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: row.brand_id,
        action: decision === 'approve' ? 'example.approve' : 'example.reject',
        targetType: 'reply_example',
        targetId: row.id,
        summary: decision === 'approve' ? `${user.name} 審核通過回覆範例` : `${user.name} 退回回覆範例${note ? `：${note}` : ''}`,
      });
    });
    res.json(toExample(await loadExample(req.db, scope.brandIds, row.id)));
  });

  return r;
}
