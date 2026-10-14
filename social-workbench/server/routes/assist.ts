// AI 協助處理留言：多版本回覆建議、送出前檢查、人工修正分類與優先級。
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { all, get, insert, parseJson, tx, updateById, type DB } from '../db';
import { authed } from '../auth/middleware';
import type { BrandScope } from '../auth/scope';
import type { AuthUser } from '../auth/session';
import { audit } from '../services/audit';
import { assertNotLockedByOther, loadComment, type CommentRow } from '../services/comments';
import { badRequest, notFound } from '../lib/errors';
import { addMinutes, nowIso } from '../lib/clock';
import { mockProvider } from '../ai/mockProvider';
import { forceHumanReasons } from '../ai/safety';
import { searchKnowledge } from '../ai/knowledge';
import { checkReply, composeVariants, loadFullStyle } from '../ai/compose';
import { PRIORITIES, PRIORITY_LABELS, SLA_ACTIVE_STATUSES, type Priority, type RiskFlag, type Sentiment } from '../../shared/constants';
import type { KnowledgeHit, ReplyCheckResult, SuggestionSet, SuggestionsResponse } from '../../shared/types';
import { buildDetail } from './inbox';

interface Ctx {
  c: CommentRow & { category_id: number | null; risk_flags: string; sentiment: Sentiment | null; rating: number | null; priority: Priority | null; occurred_at: string; sla_due_at: string | null };
  categoryKey: string;
  categoryName: string;
  brand: { id: number; name: string; code: string };
  platform: string;
}

async function loadCtx(db: DB, scope: BrandScope, id: number): Promise<Ctx> {
  const c = (await loadComment(db, scope, id)) as Ctx['c'];
  const cat = c.category_id ? await get<{ key: string; name: string }>(db, 'SELECT key, name FROM comment_categories WHERE id = ?', [c.category_id]) : undefined;
  const brand = (await get<Ctx['brand']>(db, 'SELECT id, name, code FROM brands WHERE id = ?', [c.brand_id]))!;
  const acct = (await get<{ platform: string }>(db, 'SELECT platform FROM social_accounts WHERE id = ?', [c.social_account_id]))!;
  return { c, categoryKey: cat?.key ?? 'other', categoryName: cat?.name ?? '其他', brand, platform: acct.platform };
}

/** 依留言目前的分類（含人工修正）整理建議的背景資訊 */
async function buildMeta(db: DB, ctx: Ctx) {
  const ai = await mockProvider.analyze({ body: ctx.c.body, authorName: ctx.c.author_name, rating: ctx.c.rating, platform: ctx.platform, brandCode: ctx.brand.code });
  const riskFlags = parseJson<RiskFlag[]>(ctx.c.risk_flags, []);
  const analysis = { ...ai, categoryKey: ctx.categoryKey, riskFlags, sentiment: ctx.c.sentiment ?? ai.sentiment };
  const kn = await searchKnowledge(db, { brandId: ctx.brand.id, body: ctx.c.body, categoryKey: ctx.categoryKey, categoryName: ctx.categoryName });
  const forceHuman = forceHumanReasons(analysis, { needsKnowledge: kn.needsKnowledge, hasHits: kn.hits.length > 0 }).filter((r) => r.code !== 'needs_review');
  const guidance = ctx.c.category_id
    ? ((await get<{ tone_note: string }>(db, 'SELECT tone_note FROM brand_category_settings WHERE brand_id = ? AND category_id = ?', [ctx.brand.id, ctx.c.category_id]))?.tone_note ?? '')
    : '';
  const style = await loadFullStyle(db, ctx.brand.id);
  const knowledgeGap = kn.needsKnowledge && kn.hits.length === 0;
  const notes: string[] = [];
  if (knowledgeGap) notes.push('知識不足：知識庫找不到可引用的資料，建議的回覆不包含價格、規格等事實。請確認後再回覆，或請對方私訊由專人說明。');
  for (const s of kn.skipped) notes.push(`知識「${s.title}」${s.reason}，沒有使用。`);
  const critical = forceHuman.filter((r) => ['complaint', 'refund', 'sensitive', 'promise', 'risk'].includes(r.code));
  if (critical.length) notes.push(`這則留言需要人工判斷（${critical.map((r) => r.label).join('、')}），建議內容只做致歉與引導私訊，不承諾退款、賠償或處理時間。`);
  return { analysis, kn, forceHuman, guidance, style, knowledgeGap, notes };
}

async function latestSet(db: DB, ctx: Ctx): Promise<SuggestionSet | null> {
  const round = await get<{ r: number | null }>(db, 'SELECT MAX(generation_round) AS r FROM ai_suggestions WHERE comment_id = ?', [ctx.c.id]);
  if (!round?.r) return null;
  const rows = await all<{ id: number; variant_key: string; variant_label: string; body: string; knowledge_ids: string; created_at: string; requested_by_name: string | null }>(
    db,
    `SELECT s.id, s.variant_key, s.variant_label, s.body, s.knowledge_ids, s.created_at, u.name AS requested_by_name
     FROM ai_suggestions s LEFT JOIN users u ON u.id = s.requested_by_id WHERE s.comment_id = ? AND s.generation_round = ? ORDER BY s.id`,
    [ctx.c.id, round.r],
  );
  const meta = await buildMeta(db, ctx);
  const ids = [...new Set(rows.flatMap((r) => parseJson<number[]>(r.knowledge_ids, [])))];
  const used: KnowledgeHit[] = ids.length
    ? (await all<{ id: number; title: string; category: KnowledgeHit['category']; content: string }>(db, `SELECT id, title, category, content FROM knowledge_items WHERE id IN (${ids.map(Number).join(',')})`)).map((k) => ({
        ...k,
        matched: meta.kn.hits.find((h) => h.id === k.id)?.matched ?? [],
      }))
    : [];
  const hits = [...used, ...meta.kn.hits.filter((h) => !ids.includes(h.id))];
  const variants = [];
  for (const r of rows) {
    variants.push({ id: r.id, key: r.variant_key, label: r.variant_label, body: r.body, knowledgeIds: parseJson<number[]>(r.knowledge_ids, []), warnings: await checkReply(db, ctx.brand.id, r.body, meta.style) });
  }
  if (!meta.style.variants.find((v) => v.key === 'lively')?.enabled) {
    /* 品牌停用活潑版時不另外提示 */
  } else if (!variants.some((v) => v.key === 'lively')) meta.notes.push('客訴、安全或敏感議題不提供活潑版。');
  return {
    round: round.r,
    createdAt: rows[0]?.created_at ?? '',
    requestedByName: rows[0]?.requested_by_name ?? null,
    categoryKey: ctx.categoryKey,
    categoryName: ctx.categoryName,
    needsKnowledge: meta.kn.needsKnowledge,
    knowledgeGap: meta.knowledgeGap,
    hits,
    skipped: meta.kn.skipped,
    forceHuman: meta.forceHuman,
    guidance: meta.guidance,
    forbiddenPromises: meta.style.forbiddenPromises,
    variants,
    notes: meta.notes,
  };
}

async function generate(db: DB, ctx: Ctx, user: AuthUser): Promise<void> {
  const meta = await buildMeta(db, ctx);
  const round = ((await get<{ r: number | null }>(db, 'SELECT MAX(generation_round) AS r FROM ai_suggestions WHERE comment_id = ?', [ctx.c.id]))?.r ?? 0) + 1;
  const variants = composeVariants({
    body: ctx.c.body,
    categoryKey: ctx.categoryKey,
    riskFlags: meta.analysis.riskFlags,
    sentiment: meta.analysis.sentiment,
    brandName: ctx.brand.name,
    style: meta.style,
    hits: meta.kn.hits,
    needsKnowledge: meta.kn.needsKnowledge,
    // 每次重新產生換一種說法
    seed: ctx.c.id * 7 + round * 3,
  });
  const analysis = await get<{ id: number }>(db, 'SELECT id FROM ai_analyses WHERE comment_id = ? ORDER BY id DESC LIMIT 1', [ctx.c.id]);
  const now = nowIso();
  await tx(db, async () => {
    for (const v of variants) {
      await insert(db, 'ai_suggestions', {
        comment_id: ctx.c.id,
        brand_id: ctx.brand.id,
        analysis_id: analysis?.id ?? null,
        variant_key: v.key,
        variant_label: v.label,
        body: v.body,
        knowledge_ids: v.knowledgeIds,
        generation_round: round,
        requested_by_id: user.id,
        created_at: now,
      });
    }
    await audit(db, {
      actorType: 'ai',
      actorUserId: user.id,
      brandId: ctx.brand.id,
      commentId: ctx.c.id,
      action: 'ai.suggest',
      targetType: 'comment',
      targetId: ctx.c.id,
      summary: `AI 產生 ${variants.length} 種回覆建議（第 ${round} 次${meta.knowledgeGap ? '，知識不足' : meta.kn.hits.length ? `，引用 ${meta.kn.hits.length} 則知識` : ''}）`,
      detail: { round, knowledgeIds: meta.kn.hits.map((h) => h.id), knowledgeGap: meta.knowledgeGap },
    });
  });
}

export function assistRoutes(): Router {
  const r = Router();

  r.get('/:id/suggestions', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const ctx = await loadCtx(req.db, scope, Number(req.params.id));
    res.json({ latest: await latestSet(req.db, ctx) } satisfies SuggestionsResponse);
  });

  r.post('/:id/suggestions', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const ctx = await loadCtx(req.db, scope, Number(req.params.id));
    if (ctx.c.visibility === 'deleted') throw badRequest('留言已刪除，無法產生回覆建議');
    await generate(req.db, ctx, user);
    res.status(201).json({ latest: await latestSet(req.db, ctx) } satisfies SuggestionsResponse);
  });

  r.post('/:id/check-reply', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const ctx = await loadCtx(req.db, scope, Number(req.params.id));
    const { body } = z.object({ body: z.string().max(2000) }).parse(req.body);
    res.json({ warnings: body.trim() ? await checkReply(req.db, ctx.brand.id, body) : [] } satisfies ReplyCheckResult);
  });

  // 人工修正 AI 判斷的類型或優先級（會留下紀錄，作為日後評估 AI 準確度的依據）
  r.post('/:id/classify', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = z
      .object({
        categoryKey: z.string().min(1).optional(),
        priority: z.enum(PRIORITIES).optional(),
        reason: z.string().trim().max(200).optional(),
      })
      .refine((v) => v.categoryKey || v.priority, '請選擇要修改的類型或優先級')
      .parse(req.body);
    const db = req.db;
    const ctx = await loadCtx(db, scope, Number(req.params.id));
    await assertNotLockedByOther(db, ctx.c, user);
    const patch: Record<string, unknown> = {};
    const before = { categoryKey: ctx.categoryKey, categoryName: ctx.categoryName, priority: ctx.c.priority };
    const after: Record<string, unknown> = {};
    const parts: string[] = [];
    if (input.categoryKey && input.categoryKey !== ctx.categoryKey) {
      const cat = await get<{ id: number; name: string; is_active: number }>(db, 'SELECT id, name, is_active FROM comment_categories WHERE key = ?', [input.categoryKey]);
      if (!cat || cat.is_active !== 1) throw notFound('找不到這個留言類型');
      patch.category_id = cat.id;
      after.categoryKey = input.categoryKey;
      after.categoryName = cat.name;
      parts.push(`類型「${ctx.categoryName}」→「${cat.name}」`);
      // 還沒回覆的留言，依新類型重新計算回覆時限
      if (!ctx.c.first_response_at && SLA_ACTIVE_STATUSES.includes(ctx.c.status)) {
        const s = await get<{ sla_minutes: number | null; sla_enabled: number }>(db, 'SELECT sla_minutes, sla_enabled FROM brand_category_settings WHERE brand_id = ? AND category_id = ?', [ctx.brand.id, cat.id]);
        const minutes = s && s.sla_enabled === 1 && s.sla_minutes ? s.sla_minutes : null;
        patch.sla_minutes = minutes;
        patch.sla_due_at = minutes ? addMinutes(ctx.c.occurred_at, minutes) : null;
        after.slaDueAt = patch.sla_due_at;
        parts.push(minutes ? `回覆時限改為 ${minutes} 分鐘` : '此類型不計時');
      }
    }
    if (input.priority && input.priority !== ctx.c.priority) {
      patch.priority = input.priority;
      after.priority = input.priority;
      parts.push(`優先級「${ctx.c.priority ? PRIORITY_LABELS[ctx.c.priority] : '未設定'}」→「${PRIORITY_LABELS[input.priority]}」`);
    }
    if (parts.length) {
      await tx(db, async () => {
        await updateById(db, 'comments', ctx.c.id, { ...patch, updated_at: nowIso() });
        await audit(db, {
          actorType: 'user',
          actorUserId: user.id,
          brandId: ctx.brand.id,
          commentId: ctx.c.id,
          action: 'comment.reclassify',
          targetType: 'comment',
          targetId: ctx.c.id,
          assigneeIdAtTime: ctx.c.assignee_id,
          summary: `${user.name} 修正 AI 判斷：${parts.join('，')}${input.reason ? `（${input.reason}）` : ''}`,
          before,
          after,
          detail: input.reason ? { reason: input.reason } : undefined,
        });
      });
    }
    res.json(await buildDetail(db, user, scope, ctx.c.id));
  });

  return r;
}
