// AI 快速設定：/api/brands/:id/setup — 產生草稿（不寫入）、店家確認後一次加入。
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { get, insert, run, tx } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { ensureBrandDefaults } from '../db/bootstrap';
import { audit } from '../services/audit';
import { notFound } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { generateSetupDraft } from '../ai/setup';
import { styleSchema, writeStyle } from './style';
import { KNOWLEDGE_CATEGORIES } from '../../shared/constants';
import type { SetupApplyResult } from '../../shared/types';

const text = (max: number) => z.string().trim().max(max).default('');

export const profileSchema = z.object({
  businessName: z.string().trim().min(1, '請輸入店名').max(60),
  industry: z.string().trim().min(1, '請輸入行業，例如：美髮店').max(40),
  description: text(500),
  services: text(1000),
  brandImage: text(300),
  audience: text(200),
  addressing: z.string().trim().max(10).default('您'),
  emojiUsage: z.enum(['none', 'light', 'frequent']).default('light'),
  signature: text(40),
  address: text(200),
  hours: text(300),
  booking: text(500),
  contact: text(300),
  prices: text(2000),
  otherFacts: text(1000),
  forbiddenPromises: text(1000),
});

const applySchema = z.object({
  style: styleSchema.nullable(),
  toneNotes: z.array(z.object({ categoryId: z.number().int().positive(), note: z.string().trim().max(300) })).max(30),
  knowledge: z
    .array(
      z.object({
        category: z.enum(KNOWLEDGE_CATEGORIES),
        title: z.string().trim().min(1, '知識標題不能空白').max(60),
        content: z.string().trim().min(1, '知識內容不能空白').max(2000),
        keywords: z.array(z.string().trim().min(1).max(30)).min(1, '每則知識至少要有一個關鍵字').max(30),
      }),
    )
    .max(30),
  canned: z.array(z.object({ categoryId: z.number().int().positive().nullable(), title: z.string().trim().min(1).max(40), body: z.string().trim().min(1).max(2000) })).max(20),
  examples: z
    .array(
      z.object({
        categoryId: z.number().int().positive().nullable(),
        scenario: z.string().trim().max(100),
        sampleComment: z.string().trim().min(1).max(1000),
        goodReply: z.string().trim().min(1).max(2000),
        badReply: z.string().trim().max(2000),
        notes: z.string().trim().max(300),
      }),
    )
    .max(20),
});

export function setupRoutes(): Router {
  const r = Router({ mergeParams: true });
  const brandOf = async (req: Request) => {
    const { scope } = authed(req);
    const brandId = Number((req.params as { id: string }).id);
    if (!scope.activeBrandIds.includes(brandId)) throw notFound('找不到品牌');
    return (await get<{ id: number; name: string }>(req.db, 'SELECT id, name FROM brands WHERE id = ?', [brandId]))!;
  };

  r.post('/draft', requirePermission('manageSettings'), async (req: Request, res: Response) => {
    const brand = await brandOf(req);
    const profile = profileSchema.parse(req.body);
    res.json(await generateSetupDraft(req.db, brand.id, profile));
  });

  r.post('/apply', requirePermission('manageSettings'), async (req: Request, res: Response) => {
    const { user } = authed(req);
    const brand = await brandOf(req);
    const input = applySchema.parse(req.body);
    const db = req.db;
    const result: SetupApplyResult = { style: false, toneNotes: 0, knowledge: 0, canned: 0, examples: 0, skipped: [] };
    if (input.style) result.style = await writeStyle(db, brand.id, input.style, user, brand.name, undefined, `${user.name} 用 AI 快速設定更新「${brand.name}」的回覆風格`);
    await ensureBrandDefaults(db, brand.id, user.id);
    const now = nowIso();
    await tx(db, async () => {
      for (const t of input.toneNotes) {
        const r2 = await run(db, 'UPDATE brand_category_settings SET tone_note = ?, updated_by_id = ?, updated_at = ? WHERE brand_id = ? AND category_id = ?', [t.note, user.id, now, brand.id, t.categoryId]);
        result.toneNotes += r2.changes;
      }
      for (const k of input.knowledge) {
        if (await get(db, 'SELECT id FROM knowledge_items WHERE brand_id = ? AND title = ?', [brand.id, k.title])) {
          result.skipped.push(`知識「${k.title}」已存在`);
          continue;
        }
        const keywords = [...new Set(k.keywords)];
        const id = await insert(db, 'knowledge_items', {
          brand_id: brand.id,
          category: k.category,
          title: k.title,
          content: k.content,
          keywords,
          is_active: true,
          review_status: 'approved',
          source: 'manual',
          version: 1,
          created_by_id: user.id,
          updated_by_id: user.id,
          approved_by_id: user.id,
          created_at: now,
          updated_at: now,
        });
        await insert(db, 'knowledge_revisions', {
          knowledge_id: id,
          brand_id: brand.id,
          version: 1,
          change_type: 'create',
          snapshot: { title: k.title, content: k.content, keywords, category: k.category, validFrom: null, validTo: null },
          note: 'AI 快速設定',
          changed_by_id: user.id,
          created_at: now,
        });
        result.knowledge++;
      }
      for (const c of input.canned) {
        if (await get(db, 'SELECT id FROM canned_replies WHERE brand_id = ? AND title = ?', [brand.id, c.title])) {
          result.skipped.push(`標準回覆「${c.title}」已存在`);
          continue;
        }
        await insert(db, 'canned_replies', { brand_id: brand.id, category_id: c.categoryId, title: c.title, body: c.body, is_active: true, created_by_id: user.id, created_at: now, updated_at: now });
        result.canned++;
      }
      for (const e of input.examples) {
        await insert(db, 'reply_examples', {
          brand_id: brand.id,
          category_id: e.categoryId,
          scenario: e.scenario,
          sample_comment: e.sampleComment,
          good_reply: e.goodReply,
          bad_reply: e.badReply,
          notes: e.notes,
          status: 'active',
          source: 'manual',
          submitted_by_id: user.id,
          approved_by_id: user.id,
          created_at: now,
          updated_at: now,
        });
        result.examples++;
      }
      await audit(db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: brand.id,
        action: 'brand.quick_setup',
        targetType: 'brand',
        targetId: brand.id,
        summary: `${user.name} 用 AI 快速設定「${brand.name}」：${result.style ? '回覆風格、' : ''}${result.toneNotes} 種類型語氣、${result.knowledge} 則知識、${result.canned} 則標準回覆、${result.examples} 則回覆範例`,
        after: { ...result },
      });
    });
    res.json(result);
  });

  return r;
}
