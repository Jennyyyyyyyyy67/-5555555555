// 真實平台帳號的自動同步：收件匣更新時、Instagram Webhook 通知時觸發。
import type { DB } from '../db';
import { all, run, sqlIn } from '../db';
import { nowIso } from '../lib/clock';
import { syncAccountDetailed, type SyncSummary } from './pipeline';

/** 收件匣多久自動向平台同步一次 */
export const AUTO_SYNC_SECONDS = 45;
/** Google（YouTube、商家評論）每天的免費 API 配額有限，自動同步的間隔拉長；手動「立即同步」不受限制 */
const SLOW_SYNC_SECONDS: Record<string, number> = { youtube: 300, google_business: 600 };

async function safeSync(db: DB, accountId: number): Promise<SyncSummary | null> {
  try {
    return await syncAccountDetailed(db, accountId, { budgetMs: 6_000 });
  } catch (err) {
    console.warn(`[sync] 帳號 #${accountId} 同步失敗：`, (err as Error).message);
    await run(db, "UPDATE social_accounts SET status = 'error', last_checked_at = ? WHERE id = ?", [nowIso(), accountId]).catch(() => {});
    return null;
  }
}

/**
 * 同步品牌範圍內、已連結真實平台且超過一段時間沒同步的帳號。
 * 一定等同步完成才回應（Vercel 回應後會停止執行，不能留在背景跑），每個帳號以時間預算分批處理。
 */
export async function autoSyncLive(db: DB, brandIds: number[]): Promise<{ synced: number; newComments: number }> {
  if (brandIds.length === 0) return { synced: 0, newComments: 0 };
  const cutoff = new Date(Date.now() - AUTO_SYNC_SECONDS * 1000).toISOString();
  const rows = await all<{ id: number; provider: string; last_synced_at: string | null }>(
    db,
    `SELECT a.id, c.provider, a.last_synced_at FROM social_accounts a JOIN account_credentials c ON c.account_id = a.id
     WHERE a.is_active = 1 AND ${sqlIn('a.brand_id', brandIds)} AND (a.last_synced_at IS NULL OR a.last_synced_at < ?)`,
    [cutoff],
  );
  const due = rows.filter((r) => {
    const slow = SLOW_SYNC_SECONDS[r.provider];
    return !slow || !r.last_synced_at || Date.parse(r.last_synced_at) < Date.now() - slow * 1000;
  });
  if (due.length === 0) return { synced: 0, newComments: 0 };
  // 先標記時間，避免多個同時的請求重複同步
  await run(db, `UPDATE social_accounts SET last_synced_at = ? WHERE ${sqlIn('id', due.map((d) => d.id))}`, [nowIso()]);
  const results = await Promise.all(due.map((d) => safeSync(db, d.id)));
  return { synced: due.length, newComments: results.reduce((n, r) => n + (r?.newComments ?? 0), 0) };
}

/** Webhook：依平台帳號 id 找到對應帳號並同步（找不到就同步所有已連結的同平台帳號） */
export async function syncByPlatformUser(db: DB, provider: string, platformUserIds: string[]): Promise<number> {
  let rows = await all<{ id: number }>(
    db,
    `SELECT a.id FROM social_accounts a JOIN account_credentials c ON c.account_id = a.id
     WHERE a.is_active = 1 AND c.provider = ? AND (a.external_id IN (SELECT jsonb_array_elements_text(?::jsonb)) OR c.platform_user_id IN (SELECT jsonb_array_elements_text(?::jsonb)))`,
    [provider, JSON.stringify(platformUserIds), JSON.stringify(platformUserIds)],
  );
  if (rows.length === 0) {
    rows = await all<{ id: number }>(db, 'SELECT a.id FROM social_accounts a JOIN account_credentials c ON c.account_id = a.id WHERE a.is_active = 1 AND c.provider = ?', [provider]);
  }
  await Promise.all(rows.map((r) => safeSync(db, r.id)));
  return rows.length;
}

export { safeSync };
