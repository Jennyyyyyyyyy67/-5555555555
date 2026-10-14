// 品牌 AI 回覆風格：查看、修改（管理員），以及用範例留言預覽各版本回覆。
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { get, run, tx } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { audit, diffFields } from '../services/audit';
import { notFound } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { composeVariants, checkReply, DEFAULT_VARIANTS, loadFullStyle } from '../ai/compose';
import { searchKnowledge } from '../ai/knowledge';
import { mockProvider } from '../ai/mockProvider';
import type { BrandStyleView, SuggestionVariant } from '../../shared/types';

const list = (max: number, label: string) => z.array(z.string().trim().min(1).max(60, `${label}每項最多 60 個字`)).max(max, `${label}最多 ${max} 項`);

export const styleSchema = z.object({
  personality: z.string().trim().max(200, '品牌個性最多 200 個字'),
  speakingStyle: z.string().trim().max(300, '說話方式最多 300 個字'),
  tone: z.string().trim().max(100, '語氣最多 100 個字'),
  formality: z.number().int().min(1).max(5),
  humor: z.number().int().min(1).max(5),
  replyLength: z.enum(['short', 'medium', 'long']),
  emojiUsage: z.enum(['none', 'light', 'frequent']),
  addressing: z.string().trim().min(1, '請輸入對顧客的稱呼').max(10, '稱呼最多 10 個字'),
  commonPhrases: list(20, '常用語'),
  bannedWords: list(50, '禁用詞'),
  unsuitableTones: list(20, '不適合的語氣'),
  forbiddenPromises: list(20, '不可承諾事項'),
  signature: z.string().trim().max(40, '署名最多 40 個字'),
  variants: z
    .array(z.object({ key: z.enum(['friendly', 'concise', 'lively', 'professional']), label: z.string(), enabled: z.boolean() }))
    .refine((v) => v.some((x) => x.enabled), '至少要開啟一種回覆版本'),
});

export function styleRoutes(): Router {
  const r = Router({ mergeParams: true });
  const brandIdOf = (req: Request) => Number((req.params as { id: string }).id);

  r.get('/', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandId = brandIdOf(req);
    if (!scope.brandIds.includes(brandId)) throw notFound('找不到品牌');
    res.json(await loadFullStyle(req.db, brandId));
  });

  r.put('/', requirePermission('manageSettings'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const brandId = brandIdOf(req);
    if (!scope.brandIds.includes(brandId)) throw notFound('找不到品牌');
    const input = styleSchema.parse(req.body);
    const current = await loadFullStyle(req.db, brandId);
    const brand = (await get<{ name: string }>(req.db, 'SELECT name FROM brands WHERE id = ?', [brandId]))!;
    const { brandId: _b, updatedAt: _u, updatedByName: _n, ...curInput } = current;
    const diff = diffFields(curInput, input);
    if (diff) {
      const variants = DEFAULT_VARIANTS.map((d) => ({ ...d, enabled: input.variants.find((v) => v.key === d.key)?.enabled ?? true }));
      await tx(req.db, async () => {
        await run(
          req.db,
          `INSERT INTO brand_styles (brand_id, updated_at) VALUES (?, ?) ON CONFLICT (brand_id) DO NOTHING`,
          [brandId, nowIso()],
        );
        await run(
          req.db,
          `UPDATE brand_styles SET personality = :personality, speaking_style = :speaking_style, tone = :tone, formality = :formality, humor = :humor,
             reply_length = :reply_length, emoji_usage = :emoji_usage, addressing = :addressing, common_phrases = :common_phrases,
             banned_words = :banned_words, unsuitable_tones = :unsuitable_tones, forbidden_promises = :forbidden_promises, signature = :signature,
             variants = :variants, updated_by_id = :updated_by_id, updated_at = :updated_at WHERE brand_id = :brand_id`,
          {
            personality: input.personality,
            speaking_style: input.speakingStyle,
            tone: input.tone,
            formality: input.formality,
            humor: input.humor,
            reply_length: input.replyLength,
            emoji_usage: input.emojiUsage,
            addressing: input.addressing,
            common_phrases: input.commonPhrases,
            banned_words: input.bannedWords,
            unsuitable_tones: input.unsuitableTones,
            forbidden_promises: input.forbiddenPromises,
            signature: input.signature,
            variants,
            updated_by_id: user.id,
            updated_at: nowIso(),
            brand_id: brandId,
          },
        );
        await audit(req.db, {
          actorType: 'user',
          actorUserId: user.id,
          brandId,
          action: 'brand.style_update',
          targetType: 'brand',
          targetId: brandId,
          summary: `${user.name} 修改「${brand.name}」的 AI 回覆風格`,
          before: diff.before,
          after: diff.after,
        });
      });
    }
    res.json(await loadFullStyle(req.db, brandId));
  });

  // 預覽：用尚未儲存的風格設定，看 AI 對一則範例留言會怎麼回（不寫入資料庫）
  r.post('/preview', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandId = brandIdOf(req);
    if (!scope.brandIds.includes(brandId)) throw notFound('找不到品牌');
    const { body, style } = z.object({ body: z.string().trim().min(1, '請輸入範例留言').max(1000), style: styleSchema }).parse(req.body);
    const brand = (await get<{ name: string; code: string }>(req.db, 'SELECT name, code FROM brands WHERE id = ?', [brandId]))!;
    const a = await mockProvider.analyze({ body, authorName: '', rating: null, platform: 'facebook', brandCode: brand.code });
    const cat = await get<{ name: string }>(req.db, 'SELECT name FROM comment_categories WHERE key = ?', [a.categoryKey]);
    const kn = await searchKnowledge(req.db, { brandId, body, categoryKey: a.categoryKey, categoryName: cat?.name ?? a.categoryKey });
    const full: BrandStyleView = { ...style, brandId, updatedAt: '', updatedByName: null };
    const variants = composeVariants({ body, categoryKey: a.categoryKey, riskFlags: a.riskFlags, sentiment: a.sentiment, brandName: brand.name, style: full, hits: kn.hits, needsKnowledge: kn.needsKnowledge, seed: body.length });
    const out: SuggestionVariant[] = [];
    for (const v of variants) out.push({ id: null, key: v.key, label: v.label, body: v.body, knowledgeIds: v.knowledgeIds, warnings: await checkReply(req.db, brandId, v.body, full) });
    res.json({ categoryName: cat?.name ?? a.categoryKey, knowledgeGap: kn.needsKnowledge && kn.hits.length === 0, hits: kn.hits, variants: out });
  });

  return r;
}
