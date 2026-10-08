import { Router } from 'express';
import { all } from '../db';
import { platformMeta } from '../adapters/registry';
import type { CategoryMeta, MetaResponse } from '../../shared/types';
import type { Priority } from '../../shared/constants';

export async function listCategories(db: Parameters<typeof all>[0]): Promise<CategoryMeta[]> {
  const rows = await all<{
    id: number;
    key: string;
    name: string;
    description: string;
    default_sla_minutes: number | null;
    default_priority: Priority;
    needs_reply: number;
    is_active: number;
    sort_order: number;
  }>(db, 'SELECT * FROM comment_categories ORDER BY sort_order, id');
  return rows.map((c) => ({
    id: c.id,
    key: c.key,
    name: c.name,
    description: c.description,
    slaMinutes: c.default_sla_minutes,
    defaultPriority: c.default_priority,
    needsReply: c.needs_reply === 1,
    isActive: c.is_active === 1,
    sortOrder: c.sort_order,
  }));
}

/** GET /api/meta：平台、帳號類型、可用動作、留言類型等系統中繼資料 */
export function metaRoutes(): Router {
  const r = Router();
  r.get('/', async (req, res) => {
    const body: MetaResponse = { platforms: platformMeta(), categories: await listCategories(req.db) };
    res.json(body);
  });
  return r;
}
