// 留言類型（管理員可新增、停用、調整）與各品牌的回覆時效設定
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { all, get, insert, run, tx, updateById } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { ensureBrandDefaults } from '../db/bootstrap';
import { audit, diffFields } from '../services/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { listCategories } from './meta';
import { HANDLING_MODES, PRIORITIES } from '../../shared/constants';
import type { BrandCategorySetting } from '../../shared/types';

const slaField = z
  .number({ invalid_type_error: '時效必須是分鐘數' })
  .int('時效必須是整數分鐘')
  .min(1, '時效至少 1 分鐘')
  .max(7 * 24 * 60, '時效最多 7 天')
  .nullable();

const categorySchema = z.object({
  name: z.string().trim().min(1, '請輸入類型名稱').max(20, '類型名稱最多 20 個字'),
  description: z.string().trim().max(100, '說明最多 100 個字').optional(),
  defaultSlaMinutes: slaField,
  defaultPriority: z.enum(PRIORITIES, { errorMap: () => ({ message: '請選擇預設優先級' }) }),
  needsReply: z.boolean(),
});

export function categoryRoutes(): Router {
  const r = Router();

  r.get('/', async (req: Request, res: Response) => {
    res.json(await listCategories(req.db));
  });

  r.post('/', requirePermission('manageSystem'), async (req: Request, res: Response) => {
    const { user } = authed(req);
    const input = categorySchema.parse(req.body);
    if (await get(req.db, 'SELECT id FROM comment_categories WHERE name = ?', [input.name])) throw conflict('已有相同名稱的留言類型', { field: 'name' });
    const now = nowIso();
    const id = await tx(req.db, async () => {
      const max = await get<{ m: number | null }>(req.db, 'SELECT MAX(sort_order) AS m FROM comment_categories');
      const id = await insert(req.db, 'comment_categories', {
        key: `custom_${Date.now().toString(36)}`,
        name: input.name,
        description: input.description ?? '',
        default_sla_minutes: input.defaultSlaMinutes,
        default_priority: input.defaultPriority,
        needs_reply: input.needsReply,
        default_mode: 'ai_suggest',
        is_system: false,
        is_active: true,
        sort_order: (max?.m ?? 0) + 10,
        created_at: now,
        updated_at: now,
      });
      // 每個品牌都建立這個類型的預設時效設定
      for (const b of await all<{ id: number }>(req.db, 'SELECT id FROM brands')) await ensureBrandDefaults(req.db, b.id, user.id);
      await audit(req.db, {
        actorType: 'user',
        actorUserId: user.id,
        action: 'category.create',
        targetType: 'comment_category',
        targetId: id,
        summary: `新增留言類型「${input.name}」`,
        after: input,
      });
      return id;
    });
    res.status(201).json((await listCategories(req.db)).find((c) => c.id === id));
  });

  r.patch('/:id', requirePermission('manageSystem'), async (req: Request, res: Response) => {
    const { user } = authed(req);
    const id = Number(req.params.id);
    const current = (await listCategories(req.db)).find((c) => c.id === id);
    if (!current) throw notFound('找不到留言類型');
    const input = categorySchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
    if (input.name && input.name !== current.name && (await get(req.db, 'SELECT id FROM comment_categories WHERE name = ? AND id <> ?', [input.name, id]))) {
      throw conflict('已有相同名稱的留言類型', { field: 'name' });
    }
    if (input.isActive === false && current.key === 'other') throw badRequest('「其他」是無法分類時的預設類型，不能停用');
    const diff = diffFields(
      { name: current.name, description: current.description, defaultSlaMinutes: current.slaMinutes, defaultPriority: current.defaultPriority, needsReply: current.needsReply, isActive: current.isActive },
      input,
    );
    if (diff) {
      await tx(req.db, async () => {
        await updateById(req.db, 'comment_categories', id, {
          name: input.name,
          description: input.description,
          default_sla_minutes: input.defaultSlaMinutes,
          default_priority: input.defaultPriority,
          needs_reply: input.needsReply,
          is_active: input.isActive,
          updated_at: nowIso(),
        });
        await audit(req.db, {
          actorType: 'user',
          actorUserId: user.id,
          action: input.isActive === false ? 'category.deactivate' : input.isActive === true && !current.isActive ? 'category.activate' : 'category.update',
          targetType: 'comment_category',
          targetId: id,
          summary: input.isActive === false ? `停用留言類型「${current.name}」` : `修改留言類型「${input.name ?? current.name}」`,
          before: diff.before,
          after: diff.after,
        });
      });
    }
    res.json((await listCategories(req.db)).find((c) => c.id === id));
  });

  return r;
}

/** /api/brands/:id/category-settings：各品牌的類型時效 */
export function brandCategorySettingRoutes(): Router {
  const r = Router({ mergeParams: true });

  async function load(db: Request['db'], brandId: number): Promise<BrandCategorySetting[]> {
    const rows = await all<{
      category_id: number; key: string; name: string; is_active: number; default_sla_minutes: number | null;
      sla_minutes: number | null; sla_enabled: number; handling_mode: BrandCategorySetting['handlingMode'];
    }>(
      db,
      `SELECT cc.id AS category_id, cc.key, cc.name, cc.is_active, cc.default_sla_minutes, s.sla_minutes, s.sla_enabled, s.handling_mode
       FROM comment_categories cc JOIN brand_category_settings s ON s.category_id = cc.id AND s.brand_id = ?
       ORDER BY cc.sort_order, cc.id`,
      [brandId],
    );
    return rows.map((x) => ({
      categoryId: x.category_id,
      key: x.key,
      name: x.name,
      categoryActive: x.is_active === 1,
      defaultSlaMinutes: x.default_sla_minutes,
      slaMinutes: x.sla_minutes,
      slaEnabled: x.sla_enabled === 1,
      handlingMode: x.handling_mode,
    }));
  }

  r.get('/', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandId = Number((req.params as { id: string }).id);
    if (!scope.brandIds.includes(brandId)) throw notFound('找不到品牌');
    await ensureBrandDefaults(req.db, brandId);
    res.json(await load(req.db, brandId));
  });

  const putSchema = z.object({
    items: z
      .array(
        z.object({
          categoryId: z.number().int(),
          slaMinutes: slaField,
          slaEnabled: z.boolean(),
          handlingMode: z.enum(HANDLING_MODES).optional(),
        }),
      )
      .min(1),
  });
  r.put('/', requirePermission('manageSettings'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const brandId = Number((req.params as { id: string }).id);
    if (!scope.brandIds.includes(brandId)) throw notFound('找不到品牌');
    const brand = (await get<{ name: string }>(req.db, 'SELECT name FROM brands WHERE id = ?', [brandId]))!;
    const { items } = putSchema.parse(req.body);
    for (const it of items) if (it.slaEnabled && !it.slaMinutes) throw badRequest('開啟時效的類型必須填寫分鐘數');
    const current = await load(req.db, brandId);
    await tx(req.db, async () => {
      for (const it of items) {
        const before = current.find((c) => c.categoryId === it.categoryId);
        if (!before) throw badRequest('留言類型不存在');
        const changed = before.slaMinutes !== it.slaMinutes || before.slaEnabled !== it.slaEnabled || (it.handlingMode && it.handlingMode !== before.handlingMode);
        if (!changed) continue;
        await run(
          req.db,
          'UPDATE brand_category_settings SET sla_minutes = ?, sla_enabled = ?, handling_mode = COALESCE(?, handling_mode), updated_by_id = ?, updated_at = ? WHERE brand_id = ? AND category_id = ?',
          [it.slaEnabled ? it.slaMinutes : before.slaMinutes, it.slaEnabled ? 1 : 0, it.handlingMode ?? null, user.id, nowIso(), brandId, it.categoryId],
        );
        await audit(req.db, {
          actorType: 'user',
          actorUserId: user.id,
          brandId,
          action: 'brand.sla_update',
          targetType: 'comment_category',
          targetId: it.categoryId,
          summary: `修改「${brand.name}」的「${before.name}」回覆時效：${before.slaEnabled ? `${before.slaMinutes} 分鐘` : '不計時'} → ${it.slaEnabled ? `${it.slaMinutes} 分鐘` : '不計時'}`,
          before: { slaMinutes: before.slaMinutes, slaEnabled: before.slaEnabled },
          after: { slaMinutes: it.slaMinutes, slaEnabled: it.slaEnabled },
        });
      }
    });
    res.json(await load(req.db, brandId));
  });

  return r;
}

