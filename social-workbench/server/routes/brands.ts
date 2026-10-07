import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { all, get, insert, sqlIn, tx, updateById, type DB } from '../db';
import { ensureBrandDefaults } from '../db/bootstrap';
import { authed, requirePermission } from '../auth/middleware';
import type { BrandScope } from '../auth/scope';
import { audit, diffFields } from '../services/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { DEFAULT_NEAR_DUE_MINUTES } from '../../shared/constants';
import type { Brand } from '../../shared/types';

// ---------------- 輸入驗證 ----------------
const nameSchema = z
  .string({ required_error: '請輸入品牌名稱', invalid_type_error: '品牌名稱必須是文字' })
  .trim()
  .min(1, '請輸入品牌名稱')
  .max(40, '品牌名稱最多 40 個字，請縮短後再儲存');

const codeSchema = z
  .string({ required_error: '請輸入品牌代碼', invalid_type_error: '品牌代碼必須是文字' })
  .trim()
  .regex(/^[A-Za-z0-9_-]{2,12}$/, '品牌代碼需為 2–12 個英文字母、數字、底線（_）或連字號（-）')
  .transform((s) => s.toUpperCase());

const colorSchema = z
  .string({ required_error: '請選擇代表色', invalid_type_error: '代表色格式不正確' })
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, '代表色需為 #RRGGBB 格式（例如 #3355D6），請重新選擇')
  .transform((s) => s.toLowerCase());

const descriptionSchema = z
  .string({ invalid_type_error: '說明必須是文字' })
  .trim()
  .max(200, '說明最多 200 個字，請縮短後再儲存');

const nearDueSchema = z
  .number({ required_error: '請輸入即將超時門檻', invalid_type_error: '即將超時門檻必須是數字（分鐘）' })
  .int('即將超時門檻需為整數分鐘')
  .min(1, '即將超時門檻需介於 1–240 分鐘')
  .max(240, '即將超時門檻需介於 1–240 分鐘');

const createSchema = z.object({
  name: nameSchema,
  code: codeSchema,
  color: colorSchema,
  description: descriptionSchema.default(''),
  nearDueMinutes: nearDueSchema.default(DEFAULT_NEAR_DUE_MINUTES),
});

const patchSchema = z.object({
  name: nameSchema.optional(),
  // 代碼建立後不可修改；這裡只接收下來比對，不會寫入
  code: z.unknown().optional(),
  color: colorSchema.optional(),
  description: descriptionSchema.optional(),
  nearDueMinutes: nearDueSchema.optional(),
  isActive: z.boolean({ invalid_type_error: '啟用狀態必須是 true 或 false' }).optional(),
});

// ---------------- 資料讀取 ----------------
interface BrandRow {
  id: number;
  name: string;
  code: string;
  color: string;
  description: string;
  near_due_minutes: number;
  is_active: number;
  created_at: string;
  updated_at: string;
  account_count?: number;
  user_count?: number;
  comment_count?: number;
}

const COUNT_COLUMNS = `
  (SELECT COUNT(*) FROM social_accounts sa WHERE sa.brand_id = b.id) AS account_count,
  (SELECT COUNT(DISTINCT ub.user_id) FROM user_brands ub JOIN users u ON u.id = ub.user_id
     WHERE ub.brand_id = b.id AND u.is_active = 1 AND u.role <> 'admin') AS user_count,
  (SELECT COUNT(*) FROM comments c WHERE c.brand_id = b.id) AS comment_count`;

function toBrand(row: BrandRow, withCounts: boolean): Brand {
  const brand: Brand = {
    id: row.id,
    name: row.name,
    code: row.code,
    color: row.color,
    description: row.description,
    nearDueMinutes: row.near_due_minutes,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (withCounts) {
    brand.accountCount = row.account_count ?? 0;
    brand.userCount = row.user_count ?? 0;
    brand.commentCount = row.comment_count ?? 0;
  }
  return brand;
}

function listBrands(db: DB, scope: BrandScope): Brand[] {
  if (scope.isAdmin) {
    const rows = all<BrandRow>(
      db,
      `SELECT b.*, ${COUNT_COLUMNS} FROM brands b WHERE ${sqlIn('b.id', scope.brandIds)} ORDER BY b.is_active DESC, b.id`,
    );
    return rows.map((r) => toBrand(r, true));
  }
  const rows = all<BrandRow>(
    db,
    `SELECT b.* FROM brands b WHERE ${sqlIn('b.id', scope.activeBrandIds)} AND b.is_active = 1 ORDER BY b.id`,
  );
  return rows.map((r) => toBrand(r, false));
}

function parseId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 依 id 取得品牌；不存在或不在可存取範圍內一律回 404（不洩漏品牌是否存在） */
function loadBrandRow(db: DB, scope: BrandScope, rawId: unknown): BrandRow {
  const id = parseId(rawId);
  if (id === null || !scope.brandIds.includes(id)) throw notFound('找不到品牌');
  const row = scope.isAdmin
    ? get<BrandRow>(db, `SELECT b.*, ${COUNT_COLUMNS} FROM brands b WHERE b.id = ?`, [id])
    : get<BrandRow>(db, 'SELECT b.* FROM brands b WHERE b.id = ? AND b.is_active = 1', [id]);
  if (!row) throw notFound('找不到品牌');
  return row;
}

function assertNameAvailable(db: DB, name: string, exceptId: number | null): void {
  const dup = get<{ id: number }>(db, 'SELECT id FROM brands WHERE name = ? AND id <> ?', [name, exceptId ?? 0]);
  if (dup) throw conflict('品牌名稱已存在，請改用其他名稱', { field: 'name' });
}

function assertCodeAvailable(db: DB, code: string): void {
  const dup = get<{ id: number }>(db, 'SELECT id FROM brands WHERE code = ? COLLATE NOCASE', [code]);
  if (dup) throw conflict('品牌代碼已存在（不分大小寫），請改用其他代碼', { field: 'code' });
}

const FIELD_LABELS: Record<string, string> = {
  name: '名稱',
  color: '代表色',
  description: '說明',
  nearDueMinutes: '即將超時門檻',
};

// ---------------- 路由 ----------------
export function brandRoutes(): Router {
  const r = Router();

  // 所有登入者：管理員看到全部品牌（含停用）與統計；其他角色只看到自己被授權且啟用中的品牌
  r.get('/', (req: Request, res: Response) => {
    const { scope } = authed(req);
    res.json(listBrands(req.db, scope));
  });

  r.get('/:id', (req: Request, res: Response) => {
    const { scope } = authed(req);
    res.json(toBrand(loadBrandRow(req.db, scope, req.params.id), scope.isAdmin));
  });

  r.post('/', requirePermission('manageBrands'), (req: Request, res: Response) => {
    const { user } = authed(req);
    const input = createSchema.parse(req.body ?? {});
    const db = req.db;
    assertNameAvailable(db, input.name, null);
    assertCodeAvailable(db, input.code);

    const id = tx(db, () => {
      const now = nowIso();
      const newId = insert(db, 'brands', {
        name: input.name,
        code: input.code,
        color: input.color,
        description: input.description,
        near_due_minutes: input.nearDueMinutes,
        is_active: true,
        created_at: now,
        updated_at: now,
      });
      ensureBrandDefaults(db, newId, user.id);
      audit(db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: newId,
        action: 'brand.create',
        targetType: 'brand',
        targetId: newId,
        summary: `新增品牌「${input.name}」（代碼 ${input.code}）`,
        after: {
          name: input.name,
          code: input.code,
          color: input.color,
          description: input.description,
          nearDueMinutes: input.nearDueMinutes,
          isActive: true,
        },
      });
      return newId;
    });

    const row = get<BrandRow>(db, `SELECT b.*, ${COUNT_COLUMNS} FROM brands b WHERE b.id = ?`, [id])!;
    res.status(201).json(toBrand(row, true));
  });

  r.patch('/:id', requirePermission('manageBrands'), (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const db = req.db;
    const row = loadBrandRow(db, scope, req.params.id);
    const input = patchSchema.parse(req.body ?? {});

    if (input.code !== undefined) {
      const requested = typeof input.code === 'string' ? input.code.trim().toUpperCase() : null;
      if (requested !== row.code.toUpperCase()) {
        throw badRequest('品牌代碼建立後不可修改；如需不同代碼，請新增一個品牌', { field: 'code' });
      }
    }

    const current = {
      name: row.name,
      color: row.color,
      description: row.description,
      nearDueMinutes: row.near_due_minutes,
    };
    const diff = diffFields(current, {
      name: input.name,
      color: input.color,
      description: input.description,
      nearDueMinutes: input.nearDueMinutes,
    });
    const wasActive = row.is_active === 1;
    const activeChanged = input.isActive !== undefined && input.isActive !== wasActive;

    if (diff?.after.name !== undefined) assertNameAvailable(db, diff.after.name, row.id);

    if (diff || activeChanged) {
      tx(db, () => {
        const patch: Record<string, unknown> = { updated_at: nowIso() };
        if (diff) {
          if (diff.after.name !== undefined) patch.name = diff.after.name;
          if (diff.after.color !== undefined) patch.color = diff.after.color;
          if (diff.after.description !== undefined) patch.description = diff.after.description;
          if (diff.after.nearDueMinutes !== undefined) patch.near_due_minutes = diff.after.nearDueMinutes;
        }
        if (activeChanged) patch.is_active = input.isActive;
        updateById(db, 'brands', row.id, patch);

        if (diff) {
          const labels = Object.keys(diff.after).map((k) => FIELD_LABELS[k] ?? k);
          const renamed = diff.after.name !== undefined ? `（新名稱「${diff.after.name}」）` : '';
          audit(db, {
            actorType: 'user',
            actorUserId: user.id,
            brandId: row.id,
            action: 'brand.update',
            targetType: 'brand',
            targetId: row.id,
            summary: `修改品牌「${row.name}」的${labels.join('、')}${renamed}`,
            before: diff.before,
            after: diff.after,
          });
        }
        if (activeChanged) {
          const name = diff?.after.name ?? row.name;
          audit(db, {
            actorType: 'user',
            actorUserId: user.id,
            brandId: row.id,
            action: input.isActive ? 'brand.activate' : 'brand.deactivate',
            targetType: 'brand',
            targetId: row.id,
            summary: input.isActive
              ? `重新啟用品牌「${name}」，已授權的主管與操作人員可再次存取`
              : `停用品牌「${name}」，主管與操作人員將無法再存取（資料完整保留）`,
            before: { isActive: wasActive },
            after: { isActive: input.isActive },
          });
        }
      });
    }

    const updated = get<BrandRow>(db, `SELECT b.*, ${COUNT_COLUMNS} FROM brands b WHERE b.id = ?`, [row.id])!;
    res.json(toBrand(updated, true));
  });

  return r;
}
