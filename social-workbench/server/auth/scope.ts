import type { DB } from '../db';
import { all } from '../db';
import type { AuthUser } from './session';
import { badRequest, forbidden } from '../lib/errors';

/**
 * 品牌存取範圍。
 * - 管理員：所有品牌（含已停用，方便管理）。
 * - 主管／操作人員：被授權且啟用中的品牌。
 */
export interface BrandScope {
  /** 可存取的品牌 id */
  brandIds: number[];
  /** 可存取且啟用中的品牌 id（日常營運畫面用這個） */
  activeBrandIds: number[];
  isAdmin: boolean;
}

export async function computeScope(db: DB, user: AuthUser): Promise<BrandScope> {
  if (user.role === 'admin') {
    const rows = await all<{ id: number; is_active: number }>(db, 'SELECT id, is_active FROM brands ORDER BY id');
    return {
      brandIds: rows.map((r) => r.id),
      activeBrandIds: rows.filter((r) => r.is_active === 1).map((r) => r.id),
      isAdmin: true,
    };
  }
  const rows = await all<{ id: number }>(
    db,
    `SELECT b.id FROM user_brands ub JOIN brands b ON b.id = ub.brand_id
     WHERE ub.user_id = ? AND b.is_active = 1 ORDER BY b.id`,
    [user.id],
  );
  const ids = rows.map((r) => r.id);
  return { brandIds: ids, activeBrandIds: ids, isAdmin: false };
}

/** 確認可存取某品牌，否則丟出 403 */
export function assertBrandAccess(scope: BrandScope, brandId: number): void {
  if (!scope.brandIds.includes(brandId)) throw forbidden('你沒有此品牌的權限');
}

/**
 * 解析查詢參數 ?brand=。
 * - 未提供或為 'all'：回傳 fallback（預設為可存取且啟用中的品牌）。
 * - 指定品牌：驗證權限後回傳 [id]。
 */
export function resolveBrandFilter(
  scope: BrandScope,
  brandParam: unknown,
  fallback: 'active' | 'all' = 'active',
): number[] {
  if (brandParam === undefined || brandParam === '' || brandParam === 'all') {
    return fallback === 'active' ? scope.activeBrandIds : scope.brandIds;
  }
  const id = Number(brandParam);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('品牌參數不正確');
  assertBrandAccess(scope, id);
  return [id];
}
