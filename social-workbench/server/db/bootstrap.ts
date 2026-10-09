import type { DB } from './index';
import { get, run } from './index';
import { DEFAULT_CATEGORIES } from '../../shared/constants';
import { nowIso } from '../lib/clock';

/**
 * 系統基本資料（與示範資料無關，正式環境也需要）：預設留言類型。
 * 只在資料表為空時建立，不會覆蓋管理員之後的調整。
 */
export async function bootstrapSystemData(db: DB): Promise<void> {
  const row = await get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM comment_categories');
  if (row && row.n > 0) return;
  const now = nowIso();
  const values: unknown[] = [];
  const rows = DEFAULT_CATEGORIES.map((c, i) => {
    values.push(c.key, c.name, c.description, c.slaMinutes, c.defaultPriority, c.needsReply ? 1 : 0, c.defaultMode, (i + 1) * 10, now, now);
    return '(?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)';
  });
  await run(
    db,
    `INSERT INTO comment_categories
       (key, name, description, default_sla_minutes, default_priority, needs_reply, default_mode, is_system, is_active, sort_order, created_at, updated_at)
     VALUES ${rows.join(', ')}`,
    values,
  );
}

/**
 * 為品牌建立預設的「品牌 × 留言類型」設定與 AI 風格列（新增品牌時呼叫；已存在則略過）。
 */
export async function ensureBrandDefaults(db: DB, brandId: number, userId: number | null = null): Promise<void> {
  const now = nowIso();
  await run(
    db,
    `INSERT INTO brand_category_settings
       (brand_id, category_id, sla_minutes, sla_enabled, handling_mode, is_enabled, updated_by_id, updated_at)
     SELECT ?::integer, id, default_sla_minutes, CASE WHEN default_sla_minutes IS NULL THEN 0 ELSE 1 END, default_mode, 1, ?::integer, ?::text
     FROM comment_categories
     ON CONFLICT DO NOTHING`,
    [brandId, userId, now],
  );
  await run(
    db,
    `INSERT INTO brand_styles (brand_id, variants, updated_by_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [
      brandId,
      JSON.stringify([
        { key: 'friendly', label: '親切版', enabled: true },
        { key: 'concise', label: '簡潔版', enabled: true },
        { key: 'lively', label: '活潑版', enabled: true },
        { key: 'professional', label: '專業版', enabled: true },
      ]),
      userId,
      now,
    ],
  );
}
