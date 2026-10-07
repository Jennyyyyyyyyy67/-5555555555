import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { z, type ZodTypeAny } from 'zod';
import { all, get, insert, run, sqlIn, tx, updateById, type DB } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { assertBrandAccess, resolveBrandFilter, type BrandScope } from '../auth/scope';
import { hashPassword, PASSWORD_MIN_LENGTH } from '../auth/password';
import { destroyUserSessions } from '../auth/session';
import { audit } from '../services/audit';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { ROLE_LABELS, ROLES, type Role } from '../../shared/constants';
import type { UserRow } from '../../shared/types';

/** 人員名錄（指派負責人、@提及用）：只回傳最少的欄位 */
export interface UserDirectoryEntry {
  id: number;
  name: string;
  role: Role;
}

// ---------------- 輸入驗證 ----------------
const nameSchema = z
  .string({ required_error: '請輸入姓名', invalid_type_error: '姓名必須是文字' })
  .trim()
  .min(1, '請輸入姓名')
  .max(30, '姓名最多 30 個字，請縮短後再儲存');

const emailSchema = z
  .string({ required_error: '請輸入 Email', invalid_type_error: 'Email 必須是文字' })
  .trim()
  .toLowerCase()
  .min(1, '請輸入 Email')
  .max(120, 'Email 最多 120 個字元，請確認後再輸入')
  .email('Email 格式不正確，請確認後再輸入（例如 name@company.com）');

const roleSchema = z.enum(ROLES, {
  errorMap: () => ({ message: '請選擇角色（管理員、主管或操作人員）' }),
});

const passwordSchema = z
  .string({ required_error: '請輸入密碼', invalid_type_error: '密碼必須是文字' })
  .min(PASSWORD_MIN_LENGTH, `密碼至少需要 ${PASSWORD_MIN_LENGTH} 個字元，請加長後再儲存`)
  .max(200, '密碼最多 200 個字元');

const brandIdsSchema = z
  .array(z.number({ invalid_type_error: '授權品牌格式不正確' }).int('授權品牌格式不正確').positive('授權品牌格式不正確'), {
    invalid_type_error: '授權品牌格式不正確',
  })
  .max(500, '授權品牌數量過多');

const createSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  role: roleSchema,
  password: passwordSchema,
  brandIds: brandIdsSchema.default([]),
});

const patchSchema = z.object({
  name: nameSchema.optional(),
  // Email 建立後不可修改；這裡只接收下來比對，不會寫入
  email: z.unknown().optional(),
  role: roleSchema.optional(),
  isActive: z.boolean({ invalid_type_error: '啟用狀態必須是 true 或 false' }).optional(),
  brandIds: brandIdsSchema.optional(),
});

const resetPasswordSchema = z.object({ password: passwordSchema });

/** 驗證請求內容；錯誤訊息直接使用各欄位的中文說明，並在 details.field 標出欄位，方便前端顯示在對應欄位下 */
function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const field = first?.path.length ? String(first.path[0]) : null;
  const message = first?.message && /[一-鿿]/.test(first.message) ? first.message : '資料格式不正確，請檢查後再送出';
  throw new HttpError(400, 'validation_error', message, { field, issues: result.error.issues });
}

function parseId(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound('找不到此人員，可能已被移除，請重新整理頁面');
  return id;
}

// ---------------- 資料讀取 ----------------
interface UserDbRow {
  id: number;
  name: string;
  email: string;
  role: Role;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

const USER_COLUMNS = 'u.id, u.name, u.email, u.role, u.is_active, u.last_login_at, u.created_at, u.updated_at';
const ROLE_ORDER_SQL = "CASE u.role WHEN 'admin' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END";

function loadUser(db: DB, id: number): UserDbRow | undefined {
  return get<UserDbRow>(db, `SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`, [id]);
}

/** 一次讀出多位人員的授權品牌（依品牌 id 排序） */
function loadBrandIds(db: DB, userIds: number[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  if (userIds.length === 0) return map;
  const rows = all<{ user_id: number; brand_id: number }>(
    db,
    `SELECT user_id, brand_id FROM user_brands WHERE ${sqlIn('user_id', userIds)} ORDER BY brand_id`,
  );
  for (const r of rows) {
    const list = map.get(r.user_id);
    if (list) list.push(r.brand_id);
    else map.set(r.user_id, [r.brand_id]);
  }
  return map;
}

/**
 * 轉成 API 格式。管理員的 brandIds 固定為空陣列（代表全部品牌）；
 * 非管理員檢視時，只保留檢視者範圍內的品牌，不洩漏其他品牌的授權。
 */
function toUserRow(row: UserDbRow, brandIds: number[], viewer: BrandScope): UserRow {
  const visible = row.role === 'admin' ? [] : viewer.isAdmin ? brandIds : brandIds.filter((id) => viewer.brandIds.includes(id));
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isActive: row.is_active === 1,
    brandIds: visible,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildUserRow(db: DB, id: number, viewer: BrandScope): UserRow {
  const row = loadUser(db, id);
  if (!row) throw notFound('找不到此人員，可能已被移除，請重新整理頁面');
  return toUserRow(row, loadBrandIds(db, [id]).get(id) ?? [], viewer);
}

/** 確認品牌都存在，回傳 id → 名稱 */
function loadBrandNames(db: DB, ids: number[]): Map<number, string> {
  const rows = all<{ id: number; name: string }>(db, `SELECT id, name FROM brands WHERE ${sqlIn('id', ids)} ORDER BY id`);
  return new Map(rows.map((r) => [r.id, r.name]));
}

function assertBrandsExist(db: DB, ids: number[]): Map<number, string> {
  const names = loadBrandNames(db, ids);
  if (ids.some((id) => !names.has(id))) {
    throw new HttpError(400, 'validation_error', '找不到部分授權品牌，可能已被移除，請重新整理頁面後再選擇', { field: 'brandIds' });
  }
  return names;
}

const uniqSorted = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b);
const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const brandListText = (names: string[]) => (names.length ? names.join('、') : '（無）');

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function countOtherActiveAdmins(db: DB, excludeId: number): number {
  const row = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?", [
    excludeId,
  ]);
  return row?.n ?? 0;
}

// ---------------- 路由 ----------------
export function userRoutes(): Router {
  const r = Router();

  // 人員列表：管理員看全部；主管只看與自己負責品牌相關的非管理員人員（含自己）
  r.get('/', requirePermission('viewUsers'), (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const db = req.db;
    const explicitBrand = req.query.brand !== undefined && req.query.brand !== '' && req.query.brand !== 'all';
    const brandIds = resolveBrandFilter(scope, req.query.brand, 'all');
    const hasBrand = `EXISTS (SELECT 1 FROM user_brands ub WHERE ub.user_id = u.id AND ${sqlIn('ub.brand_id', brandIds)})`;

    let where: string;
    const params: Record<string, unknown> = {};
    if (scope.isAdmin) {
      // 管理員可存取所有品牌，因此指定品牌時也一併列出管理員
      where = explicitBrand ? `(u.role = 'admin' OR ${hasBrand})` : '1 = 1';
    } else {
      where = `u.role != 'admin' AND (u.id = :self OR ${hasBrand})`;
      params.self = user.id;
    }
    const rows = all<UserDbRow>(
      db,
      `SELECT ${USER_COLUMNS} FROM users u WHERE ${where}
       ORDER BY u.is_active DESC, ${ROLE_ORDER_SQL}, u.name COLLATE NOCASE, u.id`,
      params,
    );
    const brandMap = loadBrandIds(
      db,
      rows.map((u) => u.id),
    );
    res.json(rows.map((u) => toUserRow(u, brandMap.get(u.id) ?? [], scope)) satisfies UserRow[]);
  });

  // 人員名錄：指定品牌中可處理留言的啟用中人員（管理員＋被授權者）。必須放在 /:id 類路由之前。
  r.get('/directory', (req: Request, res: Response) => {
    const { scope } = authed(req);
    const raw = req.query.brand;
    if (raw === undefined || raw === '' || raw === 'all') throw badRequest('請指定品牌後再查詢人員名錄');
    const brandId = Number(raw);
    if (!Number.isSafeInteger(brandId) || brandId <= 0) throw badRequest('品牌參數不正確');
    assertBrandAccess(scope, brandId);
    const rows = all<{ id: number; name: string; role: Role }>(
      req.db,
      `SELECT u.id, u.name, u.role FROM users u
       WHERE u.is_active = 1
         AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM user_brands ub WHERE ub.user_id = u.id AND ub.brand_id = :brandId))
       ORDER BY ${ROLE_ORDER_SQL}, u.name COLLATE NOCASE, u.id`,
      { brandId },
    );
    res.json(rows.map((u) => ({ id: u.id, name: u.name, role: u.role })) satisfies UserDirectoryEntry[]);
  });

  // 新增人員
  r.post('/', requirePermission('manageUsers'), (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const db = req.db;
    const input = parseBody(createSchema, req.body);
    // 管理員可存取全部品牌，不儲存授權品牌
    const brandIds = input.role === 'admin' ? [] : uniqSorted(input.brandIds);
    const brandNames = assertBrandsExist(db, brandIds);
    if (get(db, 'SELECT id FROM users WHERE email = ? COLLATE NOCASE', [input.email])) {
      throw new HttpError(409, 'conflict', '此 Email 已被使用，請改用其他 Email 或編輯既有人員', { field: 'email' });
    }

    const id = tx(db, () => {
      const now = nowIso();
      const newId = insert(db, 'users', {
        name: input.name,
        email: input.email,
        role: input.role,
        password_hash: hashPassword(input.password),
        is_active: true,
        created_at: now,
        updated_at: now,
      });
      for (const b of brandIds) insert(db, 'user_brands', { user_id: newId, brand_id: b, created_at: now });
      const names = brandIds.map((b) => brandNames.get(b)!);
      audit(db, {
        actorType: 'user',
        actorUserId: user.id,
        action: 'user.create',
        targetType: 'user',
        targetId: newId,
        summary:
          input.role === 'admin'
            ? `新增人員「${input.name}」（${ROLE_LABELS[input.role]}，可存取全部品牌）`
            : `新增人員「${input.name}」（${ROLE_LABELS[input.role]}，授權品牌：${brandListText(names)}）`,
        after: {
          name: input.name,
          email: input.email,
          role: ROLE_LABELS[input.role],
          brands: input.role === 'admin' ? ['全部品牌'] : names,
        },
      });
      return newId;
    });
    res.status(201).json(buildUserRow(db, id, scope));
  });

  // 編輯人員：姓名、角色、授權品牌、啟用狀態
  r.patch('/:id', requirePermission('manageUsers'), (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const db = req.db;
    const id = parseId(req.params.id);
    const input = parseBody(patchSchema, req.body);
    const current = loadUser(db, id);
    if (!current) throw notFound('找不到此人員，可能已被移除，請重新整理頁面');

    if (input.email !== undefined) {
      const same = typeof input.email === 'string' && input.email.trim().toLowerCase() === current.email.toLowerCase();
      if (!same) throw new HttpError(400, 'validation_error', 'Email 建立後不可修改；如需更換，請新增一位人員並停用舊帳號', { field: 'email' });
    }

    const wasActive = current.is_active === 1;
    const nextActive = input.isActive ?? wasActive;
    const nextRole: Role = input.role ?? current.role;
    const nextName = input.name ?? current.name;

    // 系統至少需要一位啟用中的管理員
    const losesAdmin = current.role === 'admin' && wasActive && (nextRole !== 'admin' || !nextActive);
    if (losesAdmin && countOtherActiveAdmins(db, id) === 0) {
      throw badRequest('系統至少需要一位啟用中的管理員。請先將其他人員設為管理員，再調整此帳號');
    }
    if (id === user.id) {
      if (!nextActive) throw badRequest('不能停用自己的帳號；如需停用，請由其他管理員操作');
      if (nextRole !== current.role) throw badRequest('不能變更自己的角色；如需調整，請由其他管理員操作');
    }

    const oldBrandIds = loadBrandIds(db, [id]).get(id) ?? [];
    const nextBrandIds = nextRole === 'admin' ? [] : input.brandIds !== undefined ? uniqSorted(input.brandIds) : oldBrandIds;
    const brandNames = assertBrandsExist(db, uniqSorted([...oldBrandIds, ...nextBrandIds]));

    const nameChanged = nextName !== current.name;
    const roleChanged = nextRole !== current.role;
    const brandsChanged = !sameIds(oldBrandIds, nextBrandIds);
    const activeChanged = nextActive !== wasActive;

    if (nameChanged || roleChanged || brandsChanged || activeChanged) {
      tx(db, () => {
        const now = nowIso();
        updateById(db, 'users', id, {
          name: nameChanged ? nextName : undefined,
          role: roleChanged ? nextRole : undefined,
          is_active: activeChanged ? nextActive : undefined,
          updated_at: now,
        });

        if (brandsChanged) {
          const removed = oldBrandIds.filter((b) => !nextBrandIds.includes(b));
          const added = nextBrandIds.filter((b) => !oldBrandIds.includes(b));
          if (removed.length) run(db, `DELETE FROM user_brands WHERE user_id = ? AND ${sqlIn('brand_id', removed)}`, [id]);
          for (const b of added) insert(db, 'user_brands', { user_id: id, brand_id: b, created_at: now });
        }

        const base = { actorType: 'user' as const, actorUserId: user.id, targetType: 'user', targetId: id };

        if (nameChanged) {
          audit(db, {
            ...base,
            action: 'user.update',
            summary: `將人員「${current.name}」更名為「${nextName}」`,
            before: { name: current.name },
            after: { name: nextName },
          });
        }

        if (roleChanged || brandsChanged) {
          const brandText = (ids: number[], role: Role) =>
            role === 'admin' ? '全部品牌' : brandListText(ids.map((b) => brandNames.get(b)!));
          const parts: string[] = [];
          if (roleChanged) parts.push(`角色由「${ROLE_LABELS[current.role]}」改為「${ROLE_LABELS[nextRole]}」`);
          if (brandsChanged || roleChanged) {
            const before = brandText(oldBrandIds, current.role);
            const after = brandText(nextBrandIds, nextRole);
            if (before !== after) parts.push(`授權品牌由「${before}」改為「${after}」`);
          }
          const before: Record<string, unknown> = {};
          const after: Record<string, unknown> = {};
          if (roleChanged) {
            before.role = ROLE_LABELS[current.role];
            after.role = ROLE_LABELS[nextRole];
          }
          if (brandsChanged) {
            before.brands = oldBrandIds.map((b) => brandNames.get(b)!);
            after.brands = nextBrandIds.map((b) => brandNames.get(b)!);
          }
          audit(db, {
            ...base,
            action: 'user.permissions_change',
            summary: `調整「${nextName}」的權限：${parts.join('；')}`,
            before,
            after,
            detail: {
              roleKey: { before: current.role, after: nextRole },
              brandIds: { before: oldBrandIds, after: nextBrandIds },
            },
          });
        }

        if (activeChanged) {
          audit(db, {
            ...base,
            action: nextActive ? 'user.activate' : 'user.deactivate',
            summary: nextActive ? `重新啟用人員「${nextName}」` : `停用人員「${nextName}」，已登出其所有裝置`,
            before: { isActive: wasActive },
            after: { isActive: nextActive },
          });
          // 停用後立即登出所有裝置
          if (!nextActive) destroyUserSessions(db, id);
        }
      });
    }

    res.json(buildUserRow(db, id, scope));
  });

  // 重設密碼：登出此人員的其他裝置（若是重設自己的密碼，保留目前這個登入狀態）
  r.post('/:id/reset-password', requirePermission('manageUsers'), (req: Request, res: Response) => {
    const { user } = authed(req);
    const db = req.db;
    const id = parseId(req.params.id);
    const { password } = parseBody(resetPasswordSchema, req.body);
    const target = loadUser(db, id);
    if (!target) throw notFound('找不到此人員，可能已被移除，請重新整理頁面');

    tx(db, () => {
      updateById(db, 'users', id, { password_hash: hashPassword(password), updated_at: nowIso() });
      const keepCurrent = id === user.id && !!req.sessionToken;
      const revoked = keepCurrent
        ? run(db, 'DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [id, hashToken(req.sessionToken!)]).changes
        : run(db, 'DELETE FROM sessions WHERE user_id = ?', [id]).changes;
      audit(db, {
        actorType: 'user',
        actorUserId: user.id,
        action: 'user.reset_password',
        targetType: 'user',
        targetId: id,
        summary:
          id === user.id
            ? `重設自己的密碼${revoked ? `，並登出其他 ${revoked} 個裝置` : ''}`
            : `重設人員「${target.name}」的密碼${revoked ? `，並登出其 ${revoked} 個登入中的裝置` : ''}`,
        detail: { revokedSessions: revoked },
      });
    });
    res.status(204).end();
  });

  return r;
}
