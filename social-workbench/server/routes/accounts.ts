import { Router } from 'express';
import { z } from 'zod';
import { all, get, insert, sqlIn, tx, updateById, type DB } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { resolveBrandFilter, type BrandScope } from '../auth/scope';
import type { AuthUser } from '../auth/session';
import { audit, diffFields } from '../services/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { adapterKeyFor, getAccountType, getAdapter } from '../adapters/registry';
import { ACCOUNT_TYPE_LABELS, PLATFORM_LABELS, type AccountStatus } from '../../shared/constants';
import type { SocialAccount, TestConnectionResponse } from '../../shared/types';

/** 新增社群帳號的回應：帳號資料 + 建立後立即執行的連線測試結果 */
export type CreateSocialAccountResponse = SocialAccount & { connection: ConnectionResult };

interface ConnectionResult {
  ok: boolean;
  message: string;
}

interface AccountRow {
  id: number;
  brand_id: number;
  brand_name: string;
  platform: string;
  account_type: string;
  name: string;
  handle: string;
  external_id: string;
  adapter_key: string;
  status: AccountStatus;
  is_active: number;
  last_checked_at: string | null;
  last_synced_at: string | null;
  post_count: number;
  comment_count: number;
  created_at: string;
  updated_at: string;
}

const SELECT_ACCOUNT = `
  SELECT a.id, a.brand_id, b.name AS brand_name, a.platform, a.account_type, a.name, a.handle, a.external_id,
         a.adapter_key, a.status, a.is_active, a.last_checked_at, a.last_synced_at, a.created_at, a.updated_at,
         (SELECT COUNT(*) FROM posts p WHERE p.social_account_id = a.id) AS post_count,
         (SELECT COUNT(*) FROM comments c WHERE c.social_account_id = a.id) AS comment_count
  FROM social_accounts a
  JOIN brands b ON b.id = a.brand_id`;

const NOT_FOUND_MESSAGE = '找不到社群帳號，請重新整理頁面後再試';

/** 建立後不可更改的欄位（更改會讓不同品牌的資料混在一起） */
const IMMUTABLE_FIELDS = {
  brandId: (row: AccountRow) => row.brand_id,
  platform: (row: AccountRow) => row.platform,
  accountType: (row: AccountRow) => row.account_type,
  externalId: (row: AccountRow) => row.external_id,
} as const;

function toAccount(row: AccountRow): SocialAccount {
  return {
    id: row.id,
    brandId: row.brand_id,
    brandName: row.brand_name,
    platform: row.platform,
    accountType: row.account_type,
    name: row.name,
    handle: row.handle,
    externalId: row.external_id,
    adapterKey: row.adapter_key,
    status: row.status,
    isActive: row.is_active === 1,
    lastCheckedAt: row.last_checked_at,
    lastSyncedAt: row.last_synced_at,
    postCount: Number(row.post_count),
    commentCount: Number(row.comment_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseId(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound(NOT_FOUND_MESSAGE);
  return id;
}

/** 依 id 取得帳號；不存在或不在使用者的品牌範圍內一律回 404（不洩漏資料是否存在） */
function loadAccount(db: DB, scope: BrandScope, id: number): AccountRow {
  const row = get<AccountRow>(db, `${SELECT_ACCOUNT} WHERE a.id = ? AND ${sqlIn('a.brand_id', scope.brandIds)}`, [id]);
  if (!row) throw notFound(NOT_FOUND_MESSAGE);
  return row;
}

const typeLabel = (platform: string, key: string) => getAccountType(platform, key)?.label ?? ACCOUNT_TYPE_LABELS[key] ?? key;
const platformLabel = (key: string) => getAdapter(key)?.label ?? PLATFORM_LABELS[key] ?? key;

/**
 * 呼叫平台 adapter 測試連線，更新帳號狀態並寫入操作紀錄。
 * adapter 呼叫是非同步的，因此放在交易之外；結果寫回時才開交易。
 */
async function testAndRecord(db: DB, row: AccountRow, user: AuthUser): Promise<ConnectionResult> {
  const adapter = getAdapter(row.platform);
  let result: ConnectionResult;
  if (!adapter) {
    result = { ok: false, message: `系統目前沒有「${platformLabel(row.platform)}」的串接模組，無法測試連線，請聯絡系統管理員` };
  } else {
    try {
      const r = await adapter.testConnection({
        id: row.id,
        brandId: row.brand_id,
        platform: row.platform,
        accountType: row.account_type,
        externalId: row.external_id,
        name: row.name,
      });
      result = { ok: r.ok === true, message: String(r.message ?? '') };
    } catch (err) {
      console.error('[accounts] testConnection 失敗', err);
      result = { ok: false, message: '連線測試時發生錯誤，請稍後再試；若持續發生請聯絡系統管理員' };
    }
  }
  const status: AccountStatus = result.ok ? 'connected' : 'error';
  const now = nowIso();
  tx(db, () => {
    const current = get<{ status: AccountStatus; name: string }>(db, 'SELECT status, name FROM social_accounts WHERE id = ?', [row.id]);
    if (!current) return;
    updateById(db, 'social_accounts', row.id, { status, last_checked_at: now });
    audit(db, {
      actorType: 'user',
      actorUserId: user.id,
      brandId: row.brand_id,
      action: 'account.test_connection',
      targetType: 'social_account',
      targetId: row.id,
      summary: `測試社群帳號「${current.name}」連線：${result.ok ? '成功' : '失敗'}`,
      ...(current.status !== status ? { before: { status: current.status }, after: { status } } : {}),
      detail: { ok: result.ok, message: result.message },
    });
  });
  return result;
}

// ---------------- 輸入驗證 ----------------
const nameSchema = z
  .string({ required_error: '請輸入帳號名稱', invalid_type_error: '帳號名稱必須是文字' })
  .trim()
  .min(1, '請輸入帳號名稱')
  .max(60, '帳號名稱最多 60 個字');
const handleSchema = z
  .string({ invalid_type_error: '帳號代稱必須是文字' })
  .trim()
  .max(60, '帳號代稱最多 60 個字');

const createSchema = z.object({
  brandId: z
    .number({ required_error: '請選擇品牌', invalid_type_error: '請選擇品牌' })
    .int('品牌參數不正確')
    .positive('品牌參數不正確'),
  platform: z
    .string({ required_error: '請選擇平台', invalid_type_error: '請選擇平台' })
    .trim()
    .min(1, '請選擇平台')
    .max(40, '平台參數不正確'),
  accountType: z
    .string({ required_error: '請選擇帳號類型', invalid_type_error: '請選擇帳號類型' })
    .trim()
    .min(1, '請選擇帳號類型')
    .max(40, '帳號類型參數不正確'),
  name: nameSchema,
  handle: handleSchema.optional(),
  externalId: z
    .string({ required_error: '請輸入平台帳號 ID', invalid_type_error: '平台帳號 ID 必須是文字' })
    .trim()
    .min(1, '請輸入平台帳號 ID')
    .max(120, '平台帳號 ID 最多 120 個字'),
});

const patchSchema = z.object({
  name: nameSchema.optional(),
  handle: handleSchema.optional(),
  isActive: z.boolean({ invalid_type_error: '啟用狀態格式不正確' }).optional(),
});

const FIELD_LABELS: Record<string, string> = { name: '名稱', handle: '代稱' };

export function accountRoutes(): Router {
  const r = Router();

  // 列表：管理員可看到已停用品牌的帳號；主管只看到自己負責且啟用中的品牌
  r.get('/', requirePermission('viewAccounts'), (req, res) => {
    const { scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand, 'all');
    const platform = req.query.platform;
    if (platform !== undefined && typeof platform !== 'string') throw badRequest('平台參數不正確');
    const where = [sqlIn('a.brand_id', brandIds)];
    const params: unknown[] = [];
    if (platform && platform !== 'all') {
      where.push('a.platform = ?');
      params.push(platform);
    }
    const rows = all<AccountRow>(req.db, `${SELECT_ACCOUNT} WHERE ${where.join(' AND ')} ORDER BY a.brand_id, a.platform, a.id`, params);
    res.json(rows.map(toAccount) satisfies SocialAccount[]);
  });

  r.get('/:id', requirePermission('viewAccounts'), (req, res) => {
    const { scope } = authed(req);
    res.json(toAccount(loadAccount(req.db, scope, parseId(req.params.id))) satisfies SocialAccount);
  });

  r.post('/', requirePermission('manageAccounts'), async (req, res) => {
    const { user, scope } = authed(req);
    const input = createSchema.parse(req.body ?? {});
    const db = req.db;

    const brand = get<{ id: number; name: string; is_active: number }>(
      db,
      `SELECT id, name, is_active FROM brands WHERE id = ? AND ${sqlIn('id', scope.brandIds)}`,
      [input.brandId],
    );
    if (!brand) throw notFound('找不到品牌，請重新整理頁面後再選擇品牌');
    if (brand.is_active !== 1) throw badRequest('品牌已停用，無法新增社群帳號；如需新增，請先到品牌管理啟用此品牌');

    const adapter = getAdapter(input.platform);
    if (!adapter) throw badRequest(`不支援的平台「${input.platform}」，請從清單中選擇平台`);
    const typeDef = getAccountType(input.platform, input.accountType);
    if (!typeDef) throw badRequest(`此平台不支援這種帳號類型，請重新選擇${adapter.label}的帳號類型`);

    const existing = get<{ brand_name: string; is_active: number }>(
      db,
      `SELECT b.name AS brand_name, a.is_active FROM social_accounts a JOIN brands b ON b.id = a.brand_id
       WHERE a.platform = ? AND a.external_id = ?`,
      [input.platform, input.externalId],
    );
    if (existing) {
      throw conflict(
        existing.is_active === 1
          ? `此平台帳號已綁定在品牌「${existing.brand_name}」，同一個平台帳號不能重複綁定`
          : `此平台帳號已綁定在品牌「${existing.brand_name}」（目前已停用），如需繼續使用請直接重新啟用該帳號`,
      );
    }

    const now = nowIso();
    const handle = input.handle ?? '';
    const adapterKey = adapterKeyFor(input.platform);
    const id = tx(db, () => {
      const newId = insert(db, 'social_accounts', {
        brand_id: brand.id,
        platform: input.platform,
        account_type: input.accountType,
        name: input.name,
        handle,
        external_id: input.externalId,
        adapter_key: adapterKey,
        status: 'disconnected',
        is_active: true,
        created_at: now,
        updated_at: now,
      });
      audit(db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: brand.id,
        action: 'account.create',
        targetType: 'social_account',
        targetId: newId,
        summary: `為品牌「${brand.name}」新增${typeDef.label}「${input.name}」`,
        after: {
          brandId: brand.id,
          platform: input.platform,
          accountType: input.accountType,
          name: input.name,
          handle,
          externalId: input.externalId,
          adapterKey,
        },
      });
      return newId;
    });

    const connection = await testAndRecord(db, loadAccount(db, scope, id), user);
    const body: CreateSocialAccountResponse = { ...toAccount(loadAccount(db, scope, id)), connection };
    res.status(201).json(body);
  });

  r.patch('/:id', requirePermission('manageAccounts'), (req, res) => {
    const { user, scope } = authed(req);
    const db = req.db;
    const row = loadAccount(db, scope, parseId(req.params.id));
    const body: Record<string, unknown> = req.body && typeof req.body === 'object' ? req.body : {};

    for (const [field, current] of Object.entries(IMMUTABLE_FIELDS)) {
      if (field in body && String(body[field]) !== String(current(row))) {
        throw badRequest('社群帳號建立後不可更換品牌或平台，以免品牌資料混在一起；請停用後重新新增');
      }
    }
    const input = patchSchema.parse(body);

    const before = { name: row.name, handle: row.handle, isActive: row.is_active === 1 };
    const contentDiff = diffFields({ name: before.name, handle: before.handle }, { name: input.name, handle: input.handle });
    const activeChanged = input.isActive !== undefined && input.isActive !== before.isActive;
    if (!contentDiff && !activeChanged) {
      res.json(toAccount(row) satisfies SocialAccount);
      return;
    }

    const newName = input.name ?? row.name;
    tx(db, () => {
      updateById(db, 'social_accounts', row.id, {
        name: contentDiff ? newName : undefined,
        handle: contentDiff ? (input.handle ?? row.handle) : undefined,
        is_active: activeChanged ? input.isActive : undefined,
        updated_at: nowIso(),
      });
      if (contentDiff) {
        const labels = Object.keys(contentDiff.after).map((k) => FIELD_LABELS[k] ?? k);
        audit(db, {
          actorType: 'user',
          actorUserId: user.id,
          brandId: row.brand_id,
          action: 'account.update',
          targetType: 'social_account',
          targetId: row.id,
          summary:
            contentDiff.after.name !== undefined
              ? `將社群帳號「${row.name}」更名為「${newName}」`
              : `編輯社群帳號「${row.name}」的${labels.join('、')}`,
          before: contentDiff.before,
          after: contentDiff.after,
        });
      }
      if (activeChanged) {
        audit(db, {
          actorType: 'user',
          actorUserId: user.id,
          brandId: row.brand_id,
          action: input.isActive ? 'account.activate' : 'account.deactivate',
          targetType: 'social_account',
          targetId: row.id,
          summary: `${input.isActive ? '啟用' : '停用'}社群帳號「${newName}」（${typeLabel(row.platform, row.account_type)}）`,
          before: { isActive: before.isActive },
          after: { isActive: input.isActive },
        });
      }
    });
    res.json(toAccount(loadAccount(db, scope, row.id)) satisfies SocialAccount);
  });

  r.post('/:id/test', requirePermission('manageAccounts'), async (req, res) => {
    const { user, scope } = authed(req);
    const db = req.db;
    const id = parseId(req.params.id);
    const result = await testAndRecord(db, loadAccount(db, scope, id), user);
    const body: TestConnectionResponse = { ...result, account: toAccount(loadAccount(db, scope, id)) };
    res.json(body);
  });

  return r;
}
