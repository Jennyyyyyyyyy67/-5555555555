// 留言處理流程：收到留言 → AI 判斷 → 啟動時效 → 安全檢查 → 自動化規則 → 自動回覆或交給人工 → 留下紀錄。
import type { DB } from '../db';
import { all, get, insert, parseJson, run, tx, updateById } from '../db';
import { addMinutes, nowIso } from '../lib/clock';
import { audit } from './audit';
import { getAdapter, getAccountType } from '../adapters/registry';
import { mockFeed } from '../adapters/mock/mockFeed';
import { mockProvider } from '../ai/mockProvider';
import type { AIProvider, Analysis, BrandStyle } from '../ai/types';
import { forceHumanReasons, MIN_AUTO_CONFIDENCE, type ForceHumanReason } from '../ai/safety';
import { badRequest, HttpError, notFound } from '../lib/errors';

/** 目前使用的 AI；階段 3 起可依設定切換 */
export const ai: AIProvider = mockProvider;

/** 需要事實知識才能回答的類型（沒有知識庫時標記「知識不足」） */
const KNOWLEDGE_CATEGORIES = ['product_inquiry', 'price_inquiry', 'purchase_inquiry', 'usage', 'after_sales'];

export interface RuleConditions {
  /** 適用的留言類型 key */
  categories: string[];
  /** 適用平台；空陣列代表全部 */
  platforms: string[];
  /** 最低 AI 信心（不得低於系統下限） */
  minConfidence: number;
}

export interface RuleRow {
  id: number;
  brand_id: number;
  name: string;
  action: 'auto_reply' | 'auto_like';
  conditions: string;
  is_active: number;
  sort_order: number;
}

export interface RuleMatch {
  ruleId: number;
  ruleName: string;
  action: 'auto_reply' | 'auto_like';
}

export type Decision = 'auto_replied' | 'auto_liked' | 'human';

export interface PipelineResult {
  commentId: number | null;
  analysis: Analysis;
  categoryName: string;
  forceHuman: ForceHumanReason[];
  /** 符合的規則（可能因安全檢查而沒有執行） */
  matchedRule: RuleMatch | null;
  decision: Decision;
  /** 給人看的處理結果說明 */
  explanation: string;
  replyBody: string | null;
  slaMinutes: number | null;
  slaDueAt: string | null;
}

interface Context {
  brand: { id: number; name: string; code: string; is_active: number };
  account: { id: number; platform: string; account_type: string; external_id: string; name: string };
}

export function parseConditions(text: string): RuleConditions {
  const c = parseJson<Partial<RuleConditions>>(text, {});
  return {
    categories: Array.isArray(c.categories) ? c.categories : [],
    platforms: Array.isArray(c.platforms) ? c.platforms : [],
    minConfidence: Math.max(MIN_AUTO_CONFIDENCE, Number(c.minConfidence ?? MIN_AUTO_CONFIDENCE)),
  };
}

async function loadStyle(db: DB, brandId: number): Promise<BrandStyle> {
  const s = await get<{
    addressing: string;
    emoji_usage: BrandStyle['emojiUsage'];
    reply_length: BrandStyle['replyLength'];
    signature: string;
    common_phrases: string;
    banned_words: string;
  }>(db, 'SELECT addressing, emoji_usage, reply_length, signature, common_phrases, banned_words FROM brand_styles WHERE brand_id = ?', [brandId]);
  return {
    addressing: s?.addressing || '您',
    emojiUsage: s?.emoji_usage ?? 'light',
    replyLength: s?.reply_length ?? 'medium',
    signature: s?.signature ?? '',
    commonPhrases: parseJson<string[]>(s?.common_phrases, []),
    bannedWords: parseJson<string[]>(s?.banned_words, []),
  };
}

async function findRule(db: DB, brandId: number, platform: string, a: Analysis): Promise<RuleMatch | null> {
  const rules = await all<RuleRow>(
    db,
    'SELECT id, brand_id, name, action, conditions, is_active, sort_order FROM automation_rules WHERE brand_id = ? AND is_active = 1 ORDER BY sort_order, id',
    [brandId],
  );
  for (const r of rules) {
    if (r.action !== 'auto_reply' && r.action !== 'auto_like') continue;
    const c = parseConditions(r.conditions);
    if (!c.categories.includes(a.categoryKey)) continue;
    if (c.platforms.length && !c.platforms.includes(platform)) continue;
    if (a.confidence < c.minConfidence) continue;
    return { ruleId: r.id, ruleName: r.name, action: r.action };
  }
  return null;
}

function result_reason(categoryKey: string, risky: boolean): string {
  return risky
    ? '這則留言需要人工處理（原因見下方），交給人工處理。'
    : '這個品牌沒有設定適用於此類型的自動化規則，交給人工處理。';
}

/** 判斷結果（不寫入資料庫）：自動化規則測試與實際處理共用 */
export async function decide(
  db: DB,
  input: { brandId: number; brandName: string; platform: string; accountType: string; body: string; authorName: string; rating: number | null; brandCode: string; seed: number },
): Promise<Omit<PipelineResult, 'commentId' | 'slaMinutes' | 'slaDueAt'>> {
  const analysis = await ai.analyze({ body: input.body, authorName: input.authorName, rating: input.rating, platform: input.platform, brandCode: input.brandCode });
  const cat = await get<{ name: string }>(db, 'SELECT name FROM comment_categories WHERE key = ?', [analysis.categoryKey]);
  const forceHuman = forceHumanReasons(analysis);
  const matchedRule = await findRule(db, input.brandId, input.platform, analysis);
  const caps = getAccountType(input.platform, input.accountType)?.capabilities;

  let decision: Decision = 'human';
  let replyBody: string | null = null;
  let explanation: string;
  if (!matchedRule) {
    explanation = result_reason(analysis.categoryKey, forceHuman.length > 0);
  } else if (matchedRule.action === 'auto_reply') {
    if (forceHuman.length) {
      explanation = `符合規則「${matchedRule.ruleName}」，但因安全檢查轉人工：${forceHuman.map((r) => r.label).join('；')}。`;
    } else if (!caps?.reply) {
      explanation = `符合規則「${matchedRule.ruleName}」，但此平台不支援回覆，交給人工處理。`;
    } else {
      decision = 'auto_replied';
      replyBody = await ai.generateSimpleReply({
        body: input.body,
        authorName: input.authorName,
        categoryKey: analysis.categoryKey,
        brandName: input.brandName,
        style: await loadStyle(db, input.brandId),
        seed: input.seed,
      });
      explanation = `符合規則「${matchedRule.ruleName}」且通過安全檢查，AI 已自動回覆。`;
    }
  } else {
    // 自動按讚：只用於正面、無風險的留言
    if (forceHuman.some((r) => r.code !== 'knowledge_gap') || analysis.sentiment === 'negative' || analysis.riskLevel !== 'none') {
      explanation = `符合規則「${matchedRule.ruleName}」，但留言不是無風險的正面內容，不自動按讚，交給人工處理。`;
    } else if (!caps?.like) {
      explanation = `符合規則「${matchedRule.ruleName}」，但此平台不支援按讚，交給人工處理。`;
    } else {
      decision = 'auto_liked';
      explanation = `符合規則「${matchedRule.ruleName}」，已自動按讚。`;
    }
  }
  return { analysis, categoryName: cat?.name ?? analysis.categoryKey, forceHuman, matchedRule, decision, replyBody, explanation };
}

async function loadContext(db: DB, accountId: number): Promise<Context> {
  const account = await get<Context['account'] & { brand_id: number; is_active: number }>(
    db,
    'SELECT id, brand_id, platform, account_type, external_id, name, is_active FROM social_accounts WHERE id = ?',
    [accountId],
  );
  if (!account) throw notFound('找不到社群帳號');
  const brand = await get<Context['brand']>(db, 'SELECT id, name, code, is_active FROM brands WHERE id = ?', [account.brand_id]);
  if (!brand) throw notFound('找不到品牌');
  return { brand, account };
}

/**
 * 處理一則新收到的留言（已轉成資料庫需要的資訊），完整跑過判斷、時效、規則、自動回覆與紀錄。
 */
export async function processIncoming(
  db: DB,
  ctx: Context,
  c: { postId: number; parentCommentId: number | null; externalId: string; authorName: string; authorExternalId: string; body: string; rating: number | null; occurredAt: string },
): Promise<PipelineResult> {
  const now = nowIso();
  const result = await decide(db, {
    brandId: ctx.brand.id,
    brandName: ctx.brand.name,
    brandCode: ctx.brand.code,
    platform: ctx.account.platform,
    accountType: ctx.account.account_type,
    body: c.body,
    authorName: c.authorName,
    rating: c.rating,
    seed: Date.parse(c.occurredAt) / 1000,
  });
  const a = result.analysis;

  const category = await get<{ id: number }>(db, 'SELECT id FROM comment_categories WHERE key = ?', [a.categoryKey]);
  const setting = category
    ? await get<{ sla_minutes: number | null; sla_enabled: number; handling_mode: string }>(
        db,
        'SELECT sla_minutes, sla_enabled, handling_mode FROM brand_category_settings WHERE brand_id = ? AND category_id = ?',
        [ctx.brand.id, category.id],
      )
    : undefined;
  const slaMinutes = setting && setting.sla_enabled === 1 && setting.sla_minutes ? setting.sla_minutes : null;
  const slaDueAt = slaMinutes ? addMinutes(c.occurredAt, slaMinutes) : null;
  const critical = result.forceHuman.some((r) => ['sensitive', 'complaint', 'refund', 'promise', 'risk'].includes(r.code));
  const knowledgeGap = KNOWLEDGE_CATEGORIES.includes(a.categoryKey);

  let threadRootId: number | null = null;
  let parent: { id: number; thread_root_id: number | null; status: string; brand_id: number } | undefined;
  if (c.parentCommentId) {
    parent = await get(db, 'SELECT id, thread_root_id, status, brand_id FROM comments WHERE id = ?', [c.parentCommentId]);
    if (!parent || parent.brand_id !== ctx.brand.id) throw badRequest('被回覆的留言不存在或不屬於同一個品牌');
    threadRootId = parent.thread_root_id ?? parent.id;
  }

  return tx(db, async () => {
    const commentId = await insert(db, 'comments', {
      brand_id: ctx.brand.id,
      social_account_id: ctx.account.id,
      post_id: c.postId,
      parent_comment_id: c.parentCommentId,
      thread_root_id: threadRootId,
      external_id: c.externalId,
      author_name: c.authorName,
      author_external_id: c.authorExternalId,
      body: c.body,
      rating: c.rating,
      occurred_at: c.occurredAt,
      fetched_at: now,
      status: a.categoryKey === 'no_reply' ? 'pending' : 'pending',
      priority: a.priority,
      category_id: category?.id ?? null,
      tags: a.tags,
      risk_flags: a.riskFlags,
      risk_level: a.riskLevel,
      sentiment: a.sentiment,
      handling_mode: setting?.handling_mode ?? 'ai_suggest',
      knowledge_gap: knowledgeGap,
      needs_human: critical,
      sla_minutes: slaMinutes,
      sla_due_at: slaDueAt,
      created_at: now,
      updated_at: now,
    });

    const analysisId = await insert(db, 'ai_analyses', {
      comment_id: commentId,
      brand_id: ctx.brand.id,
      provider: ai.name,
      category_key: a.categoryKey,
      category_id: category?.id ?? null,
      tags: a.tags,
      risk_flags: a.riskFlags,
      risk_level: a.riskLevel,
      sentiment: a.sentiment,
      priority: a.priority,
      priority_reasons: a.reasons,
      confidence: a.confidence,
      is_ambiguous: a.isAmbiguous,
      is_multi_issue: a.isMultiIssue,
      knowledge_gap: knowledgeGap,
      force_human_reasons: result.forceHuman,
      recommended_mode: result.decision === 'auto_replied' ? 'ai_auto' : setting?.handling_mode ?? 'ai_suggest',
      final_mode: result.decision === 'auto_replied' ? 'ai_auto' : critical ? 'manual' : setting?.handling_mode ?? 'ai_suggest',
      suggested_action: result.decision === 'auto_liked' ? 'like' : result.decision === 'auto_replied' ? 'reply' : critical ? 'escalate' : 'reply',
      suggested_action_reason: result.explanation,
      created_at: now,
    });
    await updateById(db, 'comments', commentId, { latest_analysis_id: analysisId });

    await audit(db, {
      actorType: 'system',
      brandId: ctx.brand.id,
      commentId,
      action: 'comment.received',
      targetType: 'comment',
      targetId: commentId,
      summary: `收到 ${c.authorName} 的留言（${ctx.account.name}）`,
      detail: { slaMinutes, slaDueAt },
    });
    await audit(db, {
      actorType: 'ai',
      brandId: ctx.brand.id,
      commentId,
      action: 'comment.analyze',
      targetType: 'comment',
      targetId: commentId,
      summary: `AI 判斷為「${result.categoryName}」，信心 ${Math.round(a.confidence * 100)}%${result.forceHuman.length ? `，需人工：${result.forceHuman.map((r) => r.label).join('、')}` : ''}`,
      detail: { analysisId, analysis: a, forceHuman: result.forceHuman },
    });

    // 對方在「等待對方」的留言底下回覆：原留言結束，後續由這則新留言接續處理
    if (parent && parent.status === 'waiting') {
      await run(db, "UPDATE comments SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?", [c.occurredAt, now, parent.id]);
      await audit(db, {
        actorType: 'system',
        brandId: ctx.brand.id,
        commentId: parent.id,
        action: 'comment.follow_up_received',
        targetType: 'comment',
        targetId: parent.id,
        summary: `對方已回覆，原留言標示為已完成，後續由新留言 #${commentId} 接續處理`,
        before: { status: 'waiting' },
        after: { status: 'done' },
      });
    }

    if (result.decision === 'auto_replied' && result.replyBody && result.matchedRule) {
      const adapter = getAdapter(ctx.account.platform);
      const sent = adapter
        ? await adapter.replyToComment(
            { id: ctx.account.id, brandId: ctx.brand.id, platform: ctx.account.platform, accountType: ctx.account.account_type, externalId: ctx.account.external_id, name: ctx.account.name },
            { externalId: c.externalId, postExternalId: '' },
            result.replyBody,
          )
        : { ok: false as const, error: '找不到平台 adapter' };
      if (!sent.ok) {
        // 送出失敗就交給人工，不讓留言卡在「已自動處理」
        result.decision = 'human';
        result.explanation = `AI 自動回覆送出失敗（${sent.error}），已交給人工處理。`;
        await audit(db, {
          actorType: 'rule',
          ruleId: result.matchedRule.ruleId,
          brandId: ctx.brand.id,
          commentId,
          action: 'comment.auto_reply_failed',
          targetType: 'comment',
          targetId: commentId,
          summary: result.explanation,
        });
      } else {
        const sentAt = nowIso();
        const replyId = await insert(db, 'replies', {
          comment_id: commentId,
          brand_id: ctx.brand.id,
          body: result.replyBody,
          source: 'auto_rule',
          ai_original_body: result.replyBody,
          was_edited: false,
          rule_id: result.matchedRule.ruleId,
          status_after: 'done',
          platform_reply_id: sent.externalReplyId,
          delivery_status: 'sent',
          sent_at: sentAt,
          created_at: sentAt,
        });
        await updateById(db, 'comments', commentId, {
          status: 'done',
          is_auto_handled: true,
          handling_mode: 'ai_auto',
          first_response_at: sentAt,
          first_response_type: 'ai_auto',
          completed_at: sentAt,
          updated_at: sentAt,
        });
        await audit(db, {
          actorType: 'rule',
          ruleId: result.matchedRule.ruleId,
          brandId: ctx.brand.id,
          commentId,
          action: 'comment.auto_reply',
          targetType: 'comment',
          targetId: commentId,
          summary: `自動化規則「${result.matchedRule.ruleName}」自動回覆`,
          after: { status: 'done' },
          detail: { replyId, body: result.replyBody, confidence: a.confidence },
          createdAt: sentAt,
        });
      }
    } else if (result.decision === 'auto_liked' && result.matchedRule) {
      await insert(db, 'comment_actions', {
        comment_id: commentId,
        brand_id: ctx.brand.id,
        action: 'like',
        suggested_by: 'rule',
        rule_id: result.matchedRule.ruleId,
        reason: '自動化規則：正面留言自動按讚',
        result: 'success',
        created_at: nowIso(),
      });
      await updateById(db, 'comments', commentId, {
        is_liked: true,
        is_auto_handled: a.categoryKey === 'no_reply',
        status: a.categoryKey === 'no_reply' ? 'no_action' : 'pending',
        completed_at: a.categoryKey === 'no_reply' ? nowIso() : null,
      });
      await audit(db, {
        actorType: 'rule',
        ruleId: result.matchedRule.ruleId,
        brandId: ctx.brand.id,
        commentId,
        action: 'comment.auto_like',
        targetType: 'comment',
        targetId: commentId,
        summary: `自動化規則「${result.matchedRule.ruleName}」自動按讚`,
      });
    } else if (result.matchedRule) {
      await audit(db, {
        actorType: 'rule',
        ruleId: result.matchedRule.ruleId,
        brandId: ctx.brand.id,
        commentId,
        action: 'comment.auto_blocked',
        targetType: 'comment',
        targetId: commentId,
        summary: result.explanation,
        detail: { forceHuman: result.forceHuman },
      });
    }

    return { ...result, commentId, slaMinutes, slaDueAt };
  });
}

/**
 * 透過平台 adapter 取回新留言並逐則處理（模擬器把留言放進模擬平台後呼叫；日後接真實平台也是同一個流程）。
 */
export async function syncAccount(db: DB, accountId: number): Promise<PipelineResult[]> {
  const ctx = await loadContext(db, accountId);
  if (ctx.brand.is_active !== 1) throw badRequest('品牌已停用，無法接收新留言');
  const adapter = getAdapter(ctx.account.platform);
  if (!adapter) throw new HttpError(500, 'no_adapter', '找不到平台 adapter');
  const incoming = await adapter.fetchComments(
    { id: ctx.account.id, brandId: ctx.brand.id, platform: ctx.account.platform, accountType: ctx.account.account_type, externalId: ctx.account.external_id, name: ctx.account.name },
    { since: null },
  );
  const results: PipelineResult[] = [];
  for (const item of incoming) {
    const post = await get<{ id: number }>(db, 'SELECT id FROM posts WHERE social_account_id = ? AND external_id = ?', [ctx.account.id, item.postExternalId]);
    if (!post) continue;
    const parent = item.parentExternalId
      ? await get<{ id: number }>(db, 'SELECT id FROM comments WHERE social_account_id = ? AND external_id = ?', [ctx.account.id, item.parentExternalId])
      : undefined;
    results.push(
      await processIncoming(db, ctx, {
        postId: post.id,
        parentCommentId: parent?.id ?? null,
        externalId: item.externalId,
        authorName: item.authorName,
        authorExternalId: item.authorExternalId,
        body: item.body,
        rating: item.rating ?? null,
        occurredAt: item.occurredAt,
      }),
    );
  }
  return results;
}

export { mockFeed };
