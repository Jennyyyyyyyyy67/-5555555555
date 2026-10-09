import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { all, get, insert, parseJson, run, sqlIn, tx, updateById, type DB } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { assertBrandAccess, resolveBrandFilter } from '../auth/scope';
import { audit, diffFields } from '../services/audit';
import { badRequest, notFound } from '../lib/errors';
import { addMinutes, nowIso } from '../lib/clock';
import { getAdapter, listAdapters } from '../adapters/registry';
import { decide, mockFeed, parseConditions, syncAccount, type PipelineResult } from '../services/pipeline';
import { FORCE_HUMAN_RULES, MIN_AUTO_CONFIDENCE, AUTO_REPLY_ALLOWED_CATEGORIES } from '../ai/safety';
import type {
  AutomationDecision,
  AutomationMeta,
  AutomationRule,
  AutomationRulesResponse,
  SimulatePostOption,
  SimulateResult,
} from '../../shared/types';

const AUTO_LIKE_CATEGORIES = ['praise', 'no_reply', 'general'];

export const AUTOMATION_META: AutomationMeta = {
  autoReplyCategories: [...AUTO_REPLY_ALLOWED_CATEGORIES],
  autoLikeCategories: AUTO_LIKE_CATEGORIES,
  minConfidenceFloor: MIN_AUTO_CONFIDENCE,
  forceHumanRules: FORCE_HUMAN_RULES,
};

interface RuleListRow {
  id: number;
  brand_id: number;
  brand_name: string;
  name: string;
  description: string;
  action: 'auto_reply' | 'auto_like';
  conditions: string;
  is_active: number;
  sort_order: number;
  updated_at: string;
  updated_by_name: string | null;
  fired: number;
}

function toRule(r: RuleListRow): AutomationRule {
  const c = parseConditions(r.conditions);
  return {
    id: r.id,
    brandId: r.brand_id,
    brandName: r.brand_name,
    name: r.name,
    description: r.description,
    action: r.action,
    categories: c.categories,
    platforms: c.platforms,
    minConfidence: c.minConfidence,
    isActive: r.is_active === 1,
    sortOrder: r.sort_order,
    firedLast7Days: r.fired,
    updatedAt: r.updated_at,
    updatedByName: r.updated_by_name,
  };
}

async function loadRules(db: DB, where: string, params: unknown[] = []): Promise<AutomationRule[]> {
  const since = addMinutes(nowIso(), -7 * 24 * 60);
  const rows = await all<RuleListRow>(
    db,
    `SELECT r.id, r.brand_id, b.name AS brand_name, r.name, r.description, r.action, r.conditions, r.is_active, r.sort_order,
       r.updated_at, u.name AS updated_by_name,
       (SELECT COUNT(*) FROM audit_logs a WHERE a.rule_id = r.id AND a.action IN ('comment.auto_reply', 'comment.auto_like') AND a.created_at >= ?) AS fired
     FROM automation_rules r JOIN brands b ON b.id = r.brand_id LEFT JOIN users u ON u.id = r.updated_by_id
     WHERE ${where} ORDER BY r.brand_id, r.sort_order, r.id`,
    [since, ...params],
  );
  return rows.map(toRule);
}

const ruleFields = {
  name: z.string().trim().min(1, '請輸入規則名稱').max(60, '規則名稱最多 60 個字'),
  description: z.string().trim().max(300, '說明最多 300 個字').optional(),
  action: z.enum(['auto_reply', 'auto_like'], { errorMap: () => ({ message: '請選擇自動化動作' }) }),
  categories: z.array(z.string()).min(1, '請至少選擇一種留言類型'),
  platforms: z.array(z.string()).default([]),
  minConfidence: z.number({ invalid_type_error: '信心門檻格式不正確' }).min(MIN_AUTO_CONFIDENCE, `信心門檻不可低於 ${Math.round(MIN_AUTO_CONFIDENCE * 100)}%`).max(1, '信心門檻最高 100%'),
  isActive: z.boolean().default(true),
};
const createSchema = z.object({ brandId: z.number().int().positive('請選擇品牌'), ...ruleFields });
const patchSchema = z.object(ruleFields).partial();

/** 不可妥協：自動回覆只能用在低風險類型；平台必須存在 */
function validateRule(action: 'auto_reply' | 'auto_like', categories: string[], platforms: string[]): void {
  const allowed = action === 'auto_reply' ? AUTOMATION_META.autoReplyCategories : AUTO_LIKE_CATEGORIES;
  const bad = categories.filter((c) => !allowed.includes(c));
  if (bad.length) {
    throw badRequest(
      action === 'auto_reply'
        ? '自動回覆只能用於「稱讚」「一般互動」這類低風險留言。其他類型需要知識庫（階段 3）或必須由人工處理。'
        : '自動按讚只能用於「稱讚」「一般互動」「無需回覆」。',
      { field: 'categories' },
    );
  }
  const known = listAdapters().map((a) => a.platform);
  if (platforms.some((p) => !known.includes(p))) throw badRequest('不支援的平台', { field: 'platforms' });
}

function decisionView(r: Omit<PipelineResult, 'commentId' | 'slaMinutes' | 'slaDueAt'>): AutomationDecision {
  return {
    analysis: { ...r.analysis, categoryName: r.categoryName },
    forceHuman: r.forceHuman,
    matchedRule: r.matchedRule,
    decision: r.decision,
    explanation: r.explanation,
    replyBody: r.replyBody,
  };
}

export function automationRoutes(): Router {
  const r = Router();

  // 規則列表（管理員、主管可看）
  r.get('/rules', requirePermission('testAutomation'), async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand);
    const body: AutomationRulesResponse = { rules: await loadRules(req.db, sqlIn('r.brand_id', brandIds)), meta: AUTOMATION_META };
    res.json(body);
  });

  r.post('/rules', requirePermission('manageAutomation'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = createSchema.parse(req.body);
    const brand = await get<{ id: number; name: string; is_active: number }>(req.db, 'SELECT id, name, is_active FROM brands WHERE id = ?', [input.brandId]);
    if (!brand || !scope.brandIds.includes(brand.id)) throw notFound('找不到品牌');
    validateRule(input.action, input.categories, input.platforms);
    const now = nowIso();
    const id = await tx(req.db, async () => {
      const max = await get<{ m: number | null }>(req.db, 'SELECT MAX(sort_order) AS m FROM automation_rules WHERE brand_id = ?', [brand.id]);
      const id = await insert(req.db, 'automation_rules', {
        brand_id: brand.id,
        name: input.name,
        description: input.description ?? '',
        action: input.action,
        category_ids: [],
        platforms: input.platforms,
        conditions: { categories: input.categories, platforms: input.platforms, minConfidence: input.minConfidence },
        is_active: input.isActive,
        sort_order: (max?.m ?? 0) + 10,
        created_by_id: user.id,
        updated_by_id: user.id,
        created_at: now,
        updated_at: now,
      });
      await audit(req.db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: brand.id,
        action: 'automation.rule_create',
        targetType: 'automation_rule',
        targetId: id,
        summary: `新增自動化規則「${input.name}」（${brand.name}）`,
        after: input,
      });
      return id;
    });
    res.status(201).json((await loadRules(req.db, 'r.id = ?', [id]))[0]);
  });

  r.patch('/rules/:id', requirePermission('manageAutomation'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const id = Number(req.params.id);
    const current = Number.isSafeInteger(id) ? (await loadRules(req.db, 'r.id = ?', [id]))[0] : undefined;
    if (!current || !scope.brandIds.includes(current.brandId)) throw notFound('找不到自動化規則');
    const input = patchSchema.parse(req.body);
    const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as AutomationRule;
    validateRule(next.action, next.categories, next.platforms);
    const diff = diffFields(
      { name: current.name, description: current.description, action: current.action, categories: current.categories, platforms: current.platforms, minConfidence: current.minConfidence, isActive: current.isActive },
      input,
    );
    if (diff) {
      await tx(req.db, async () => {
        await updateById(req.db, 'automation_rules', id, {
          name: next.name,
          description: next.description,
          action: next.action,
          platforms: next.platforms,
          conditions: { categories: next.categories, platforms: next.platforms, minConfidence: next.minConfidence },
          is_active: next.isActive,
          updated_by_id: user.id,
          updated_at: nowIso(),
        });
        const toggled = input.isActive !== undefined && input.isActive !== current.isActive;
        await audit(req.db, {
          actorType: 'user',
          actorUserId: user.id,
          brandId: current.brandId,
          action: toggled ? (input.isActive ? 'automation.rule_enable' : 'automation.rule_disable') : 'automation.rule_update',
          targetType: 'automation_rule',
          targetId: id,
          summary: toggled ? `${input.isActive ? '啟用' : '停用'}自動化規則「${next.name}」` : `修改自動化規則「${next.name}」`,
          before: diff.before,
          after: diff.after,
        });
      });
    }
    res.json((await loadRules(req.db, 'r.id = ?', [id]))[0]);
  });

  r.delete('/rules/:id', requirePermission('manageAutomation'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const id = Number(req.params.id);
    const current = Number.isSafeInteger(id) ? (await loadRules(req.db, 'r.id = ?', [id]))[0] : undefined;
    if (!current || !scope.brandIds.includes(current.brandId)) throw notFound('找不到自動化規則');
    await tx(req.db, async () => {
      // 已執行過的回覆會保留 rule_id 紀錄，因此改為停用並移除名稱以外的條件，不實際刪除資料列
      const used = await get<{ n: number }>(req.db, 'SELECT COUNT(*) AS n FROM replies WHERE rule_id = ?', [id]);
      const usedActions = await get<{ n: number }>(req.db, 'SELECT COUNT(*) AS n FROM comment_actions WHERE rule_id = ?', [id]);
      if ((used?.n ?? 0) + (usedActions?.n ?? 0) > 0) {
        await updateById(req.db, 'automation_rules', id, { is_active: false, sort_order: 99999, updated_by_id: user.id, updated_at: nowIso() });
      } else {
        await run(req.db, 'DELETE FROM automation_rules WHERE id = ?', [id]);
      }
      await audit(req.db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: current.brandId,
        action: 'automation.rule_delete',
        targetType: 'automation_rule',
        targetId: id,
        summary: `刪除自動化規則「${current.name}」`,
        before: current,
      });
    });
    res.status(204).end();
  });

  // 測試：輸入一則留言，看 AI 判斷與是否會自動回覆（不寫入資料庫）
  const testSchema = z.object({
    brandId: z.number().int().positive('請選擇品牌'),
    platform: z.string().min(1, '請選擇平台'),
    body: z.string().trim().min(1, '請輸入留言內容').max(1000, '留言最多 1000 個字'),
    rating: z.number().int().min(1).max(5).nullable().optional(),
  });
  r.post('/test', requirePermission('testAutomation'), async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const input = testSchema.parse(req.body);
    assertBrandAccess(scope, input.brandId);
    const brand = await get<{ name: string; code: string }>(req.db, 'SELECT name, code FROM brands WHERE id = ?', [input.brandId]);
    if (!brand) throw notFound('找不到品牌');
    const adapter = getAdapter(input.platform);
    if (!adapter) throw badRequest('不支援的平台');
    const result = await decide(req.db, {
      brandId: input.brandId,
      brandName: brand.name,
      brandCode: brand.code,
      platform: input.platform,
      accountType: adapter.accountTypes[0].key,
      body: input.body,
      authorName: '測試',
      rating: input.rating ?? null,
      seed: input.body.length,
    });
    res.json(decisionView(result));
  });

  // 模擬器：可選的貼文
  r.get('/posts', requirePermission('testAutomation'), async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand);
    const rows = await all<{
      id: number; title: string; content_type: SimulatePostOption['contentType']; is_ad: number;
      brand_id: number; brand_name: string; account_id: number; account_name: string; platform: string;
    }>(
      req.db,
      `SELECT p.id, p.title, p.content_type, p.is_ad, b.id AS brand_id, b.name AS brand_name, sa.id AS account_id, sa.name AS account_name, sa.platform
       FROM posts p JOIN social_accounts sa ON sa.id = p.social_account_id JOIN brands b ON b.id = p.brand_id
       WHERE ${sqlIn('p.brand_id', brandIds)} AND sa.is_active = 1 AND b.is_active = 1
       ORDER BY b.id, sa.platform, p.published_at DESC`,
    );
    const body: SimulatePostOption[] = rows.map((p) => ({
      id: p.id, title: p.title, contentType: p.content_type, isAd: p.is_ad === 1, brandId: p.brand_id,
      brandName: p.brand_name, accountId: p.account_id, accountName: p.account_name, platform: p.platform,
    }));
    res.json(body);
  });

  // 模擬器：在模擬平台上「收到」一則新留言，走完整處理流程（adapter 取回 → AI 判斷 → 規則 → 自動回覆或交人工）
  const simulateSchema = z.object({
    postId: z.number().int().positive('請選擇貼文'),
    authorName: z.string().trim().min(1, '請輸入留言者名稱').max(40),
    body: z.string().trim().min(1, '請輸入留言內容').max(1000, '留言最多 1000 個字'),
    rating: z.number().int().min(1).max(5).nullable().optional(),
  });
  r.post('/simulate', requirePermission('testAutomation'), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = simulateSchema.parse(req.body);
    const post = await get<{ id: number; brand_id: number; external_id: string; account_id: number; platform: string; account_external_id: string; content_type: string }>(
      req.db,
      `SELECT p.id, p.brand_id, p.external_id, p.content_type, sa.id AS account_id, sa.platform, sa.external_id AS account_external_id
       FROM posts p JOIN social_accounts sa ON sa.id = p.social_account_id WHERE p.id = ?`,
      [input.postId],
    );
    if (!post || !scope.activeBrandIds.includes(post.brand_id)) throw notFound('找不到貼文');
    const rating = post.content_type === 'business_profile' ? (input.rating ?? 5) : null;
    const externalId = `sim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    mockFeed.push(post.platform, post.account_external_id, {
      externalId,
      postExternalId: post.external_id,
      parentExternalId: null,
      authorName: input.authorName,
      authorExternalId: `sim-author-${input.authorName}`,
      body: input.body,
      rating,
      occurredAt: nowIso(),
    });
    const results = await syncAccount(req.db, post.account_id);
    const result = results.find((x) => x.commentId !== null) ?? results[0];
    if (!result?.commentId) throw badRequest('模擬留言沒有成功寫入，請重試');
    await audit(req.db, {
      actorType: 'user',
      actorUserId: user.id,
      brandId: post.brand_id,
      commentId: result.commentId,
      action: 'mock.simulate_comment',
      targetType: 'comment',
      targetId: result.commentId,
      summary: `以模擬器送出一則測試留言（${input.authorName}）`,
    });
    const body: SimulateResult = { ...decisionView(result), commentId: result.commentId, slaMinutes: result.slaMinutes, slaDueAt: result.slaDueAt };
    res.status(201).json(body);
  });

  // 最近由自動化規則處理的留言（含被安全檢查擋下的）
  r.get('/recent', requirePermission('testAutomation'), async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand);
    const rows = await all<{
      id: number; action: string; summary: string; created_at: string; comment_id: number | null;
      brand_name: string; body: string | null; author_name: string | null; reply_body: string | null; detail: string | null;
    }>(
      req.db,
      `SELECT a.id, a.action, a.summary, a.created_at, a.comment_id, b.name AS brand_name, c.body, c.author_name, a.detail,
         (SELECT rp.body FROM replies rp WHERE rp.comment_id = a.comment_id AND rp.source = 'auto_rule' ORDER BY rp.id LIMIT 1) AS reply_body
       FROM audit_logs a JOIN brands b ON b.id = a.brand_id LEFT JOIN comments c ON c.id = a.comment_id
       WHERE a.actor_type = 'rule' AND ${sqlIn('a.brand_id', brandIds)}
       ORDER BY a.created_at DESC, a.id DESC LIMIT 30`,
    );
    res.json(
      rows.map((x) => ({
        id: x.id,
        action: x.action,
        summary: x.summary,
        createdAt: x.created_at,
        commentId: x.comment_id,
        brandName: x.brand_name,
        commentBody: x.body,
        authorName: x.author_name,
        replyBody: x.reply_body,
        forceHuman: parseJson<{ forceHuman?: Array<{ label: string }> }>(x.detail, {}).forceHuman?.map((f) => f.label) ?? [],
      })),
    );
  });

  return r;
}
