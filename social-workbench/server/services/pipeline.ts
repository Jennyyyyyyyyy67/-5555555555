// 留言處理流程：收到留言 → AI 判斷 → 啟動時效 → 安全檢查 → 自動化規則 → 自動回覆或交給人工 → 留下紀錄。
import type { DB } from '../db';
import { all, get, insert, parseJson, run, tx, updateById } from '../db';
import { addMinutes, nowIso } from '../lib/clock';
import { audit } from './audit';
import { getAdapter, getAccountType } from '../adapters/registry';
import { mockFeed } from '../adapters/mock/mockFeed';
import { mockProvider } from '../ai/mockProvider';
import type { AIProvider, Analysis, BrandStyle } from '../ai/types';
import { forceHumanReasons, KNOWLEDGE_AUTO_CATEGORIES, MIN_AUTO_CONFIDENCE, type ForceHumanReason } from '../ai/safety';
import { checkReply, loadFullStyle } from '../ai/compose';
import { analyzeComment, composeReplies } from '../ai/provider';
import { claudeConfig } from '../ai/claude';
import { brandDirectory, notify } from './comments';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { needsKnowledge, searchKnowledge } from '../ai/knowledge';
import { adapterAccountFor } from './credentials';
import type { KnowledgeSearchResult } from '../../shared/types';
import type { IncomingComment } from '../adapters/types';

/** 目前使用的 AI；階段 3 起可依設定切換 */
export const ai: AIProvider = mockProvider;


export interface RuleConditions {
  matchType: 'category' | 'keyword';
  /** 適用的留言類型 key */
  categories: string[];
  /** 關鍵字規則：留言包含任一關鍵字就符合 */
  keywords: string[];
  /** 關鍵字規則：回覆內容（業主自己寫，{name} 換成留言者） */
  replyTemplate: string;
  /** 適用平台；空陣列代表全部 */
  platforms: string[];
  /** 最低 AI 信心（不得低於系統下限） */
  minConfidence: number;
  /** 轉人工規則：提升為高優先 */
  raisePriority: boolean;
  /** 轉人工規則：直接指派給這位人員（null 代表不指派） */
  assigneeId: number | null;
}

export type RuleAction = 'auto_reply' | 'auto_like' | 'force_human';

export interface RuleRow {
  id: number;
  brand_id: number;
  name: string;
  action: RuleAction;
  conditions: string;
  is_active: number;
  sort_order: number;
}

export interface RuleMatch {
  ruleId: number;
  ruleName: string;
  action: RuleAction;
  matchType?: 'category' | 'keyword';
  matchedKeyword?: string;
  replyTemplate?: string;
  raisePriority?: boolean;
  assigneeId?: number | null;
}

/** 關鍵字規則由業主寫好回覆內容，不需要 AI 知識；但客訴、退款、敏感、承諾、風險仍一律轉人工 */
export const KEYWORD_BLOCKING_CODES = ['sensitive', 'complaint', 'refund', 'promise', 'risk'];

export type Decision = 'auto_replied' | 'auto_liked' | 'human';

export interface PipelineResult {
  commentId: number | null;
  analysis: Analysis;
  categoryName: string;
  forceHuman: ForceHumanReason[];
  /** 知識庫檢索結果 */
  knowledge: KnowledgeSearchResult;
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
    matchType: c.matchType === 'keyword' ? 'keyword' : 'category',
    keywords: Array.isArray(c.keywords) ? c.keywords.filter((k) => typeof k === 'string' && k.trim()) : [],
    replyTemplate: typeof c.replyTemplate === 'string' ? c.replyTemplate : '',
    categories: Array.isArray(c.categories) ? c.categories : [],
    platforms: Array.isArray(c.platforms) ? c.platforms : [],
    minConfidence: Math.max(MIN_AUTO_CONFIDENCE, Number(c.minConfidence ?? MIN_AUTO_CONFIDENCE)),
    raisePriority: c.raisePriority !== false,
    assigneeId: typeof c.assigneeId === 'number' ? c.assigneeId : null,
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

async function findRule(db: DB, brandId: number, platform: string, a: Analysis, body = ''): Promise<RuleMatch | null> {
  const rules = await all<RuleRow>(
    db,
    'SELECT id, brand_id, name, action, conditions, is_active, sort_order FROM automation_rules WHERE brand_id = ? AND is_active = 1 ORDER BY sort_order, id',
    [brandId],
  );
  const text = body.toLowerCase();
  // 轉人工規則最優先：品牌指定的情境（例如提到「律師」「消保官」）一律交給人工
  for (const r of rules) {
    if (r.action !== 'force_human') continue;
    const c = parseConditions(r.conditions);
    if (c.platforms.length && !c.platforms.includes(platform)) continue;
    const base = { ruleId: r.id, ruleName: r.name, action: 'force_human' as const, matchType: c.matchType, raisePriority: c.raisePriority, assigneeId: c.assigneeId };
    if (c.matchType === 'keyword') {
      const kw = c.keywords.find((k) => text.includes(k.trim().toLowerCase()));
      if (kw) return { ...base, matchedKeyword: kw };
    } else if (c.categories.includes(a.categoryKey)) return base;
  }
  // 關鍵字規則優先（業主明確指定的情境）
  for (const r of rules) {
    if (r.action !== 'auto_reply') continue;
    const c = parseConditions(r.conditions);
    if (c.matchType !== 'keyword' || !c.replyTemplate.trim()) continue;
    if (c.platforms.length && !c.platforms.includes(platform)) continue;
    const kw = c.keywords.find((k) => text.includes(k.trim().toLowerCase()));
    if (kw) return { ruleId: r.id, ruleName: r.name, action: 'auto_reply', matchType: 'keyword', matchedKeyword: kw, replyTemplate: c.replyTemplate };
  }
  for (const r of rules) {
    if (r.action !== 'auto_reply' && r.action !== 'auto_like') continue;
    const c = parseConditions(r.conditions);
    if (c.matchType === 'keyword') continue;
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
  input: {
    brandId: number;
    brandName: string;
    platform: string;
    accountType: string;
    body: string;
    authorName: string;
    rating: number | null;
    brandCode: string;
    seed: number;
    /** 留言所在貼文（讓 AI 理解前後文） */
    postContext?: string;
    /** 只用關鍵字規則判斷（大量舊留言） */
    fast?: boolean;
  },
): Promise<Omit<PipelineResult, 'commentId' | 'slaMinutes' | 'slaDueAt'>> {
  const analysis = await analyzeComment(
    db,
    { body: input.body, authorName: input.authorName, rating: input.rating, platform: input.platform, brandCode: input.brandCode, context: input.postContext },
    { fast: input.fast },
  );
  const cat = await get<{ name: string }>(db, 'SELECT name FROM comment_categories WHERE key = ?', [analysis.categoryKey]);
  const knowledge = await searchKnowledge(db, { brandId: input.brandId, body: input.body, categoryKey: analysis.categoryKey, categoryName: cat?.name ?? analysis.categoryKey });
  const forceHuman = forceHumanReasons(analysis, { needsKnowledge: needsKnowledge(analysis.categoryKey), hasHits: knowledge.hits.length > 0 });
  const matchedRule = await findRule(db, input.brandId, input.platform, analysis, input.body);
  const caps = getAccountType(input.platform, input.accountType)?.capabilities;

  let decision: Decision = 'human';
  let replyBody: string | null = null;
  let explanation: string;
  if (!matchedRule) {
    explanation = result_reason(analysis.categoryKey, forceHuman.length > 0);
  } else if (matchedRule.action === 'force_human') {
    const why = matchedRule.matchedKeyword ? `留言包含「${matchedRule.matchedKeyword}」` : `留言類型為「${cat?.name ?? analysis.categoryKey}」`;
    forceHuman.push({ code: 'brand_rule', label: `品牌規則「${matchedRule.ruleName}」：${why}` });
    explanation = `${why}，符合轉人工規則「${matchedRule.ruleName}」，交給人工處理${matchedRule.raisePriority ? '並提升為高優先' : ''}。`;
  } else if (matchedRule.action === 'auto_reply' && matchedRule.matchType === 'keyword') {
    const blocking = forceHuman.filter((r) => KEYWORD_BLOCKING_CODES.includes(r.code));
    if (analysis.categoryKey === 'spam' || analysis.categoryKey === 'malicious') {
      explanation = `留言包含關鍵字「${matchedRule.matchedKeyword}」，但看起來是垃圾或惡意留言，不自動回覆，交給人工處理。`;
    } else if (blocking.length) {
      explanation = `留言包含關鍵字「${matchedRule.matchedKeyword}」，符合規則「${matchedRule.ruleName}」，但因安全檢查轉人工：${blocking.map((r) => r.label).join('；')}。`;
    } else if (!caps?.reply) {
      explanation = `符合規則「${matchedRule.ruleName}」，但此平台不支援回覆，交給人工處理。`;
    } else {
      decision = 'auto_replied';
      replyBody = matchedRule.replyTemplate!.replaceAll('{name}', input.authorName.replace(/^@/, '')).trim();
      explanation = `留言包含關鍵字「${matchedRule.matchedKeyword}」，依規則「${matchedRule.ruleName}」自動回覆業主設定的內容。`;
    }
  } else if (matchedRule.action === 'auto_reply') {
    if (forceHuman.length) {
      explanation = `符合規則「${matchedRule.ruleName}」，但因安全檢查轉人工：${forceHuman.map((r) => r.label).join('；')}。`;
    } else if (!caps?.reply) {
      explanation = `符合規則「${matchedRule.ruleName}」，但此平台不支援回覆，交給人工處理。`;
    } else if ((KNOWLEDGE_AUTO_CATEGORIES as readonly string[]).includes(analysis.categoryKey)) {
      // 知識庫有答案的詢問：回覆內容直接引用知識，並通過送出前檢查才自動送出
      const style = await loadFullStyle(db, input.brandId);
      const { variants } = await composeReplies({
        authorName: input.authorName,
        postContext: input.postContext,
        body: input.body,
        categoryKey: analysis.categoryKey,
        riskFlags: analysis.riskFlags,
        sentiment: analysis.sentiment,
        brandName: input.brandName,
        style,
        hits: knowledge.hits,
        needsKnowledge: knowledge.needsKnowledge,
        seed: input.seed,
      });
      const v = variants.find((x) => x.key === 'friendly') ?? variants.find((x) => x.key !== 'lively') ?? variants[0];
      const warnings = v && v.knowledgeIds.length ? await checkReply(db, input.brandId, v.body, style) : null;
      if (!v || !v.knowledgeIds.length) {
        forceHuman.push({ code: 'knowledge_gap', label: '找不到可靠知識（需要事實資訊的問題）' });
        explanation = `符合規則「${matchedRule.ruleName}」，但找不到可以引用的知識，交給人工處理。`;
      } else if (warnings!.length) {
        forceHuman.push({ code: 'unchecked_reply', label: `AI 產生的回覆含有需要人工確認的內容：${warnings!.map((w) => w.message).join('；')}` });
        explanation = `符合規則「${matchedRule.ruleName}」，但產生的回覆需要人工確認，交給人工處理。`;
      } else {
        decision = 'auto_replied';
        replyBody = v.body;
        explanation = `符合規則「${matchedRule.ruleName}」，知識庫有可引用的答案且通過送出前檢查，AI 已自動回覆。`;
      }
    } else {
      // 稱讚、一般互動：有 Claude 時依品牌風格產生，否則用範本；送出前一樣要通過檢查
      let body: string;
      if (claudeConfig().enabled) {
        const style = await loadFullStyle(db, input.brandId);
        const { variants } = await composeReplies({
          authorName: input.authorName,
          postContext: input.postContext,
          body: input.body,
          categoryKey: analysis.categoryKey,
          riskFlags: analysis.riskFlags,
          sentiment: analysis.sentiment,
          brandName: input.brandName,
          style,
          hits: [],
          needsKnowledge: false,
          seed: input.seed,
        });
        body = (variants.find((x) => x.key === 'friendly') ?? variants.find((x) => x.key !== 'lively') ?? variants[0])?.body ?? '';
      } else {
        body = await ai.generateSimpleReply({
          body: input.body,
          authorName: input.authorName,
          categoryKey: analysis.categoryKey,
          brandName: input.brandName,
          style: await loadStyle(db, input.brandId),
          seed: input.seed,
        });
      }
      const warnings = body ? await checkReply(db, input.brandId, body) : [];
      if (!body) {
        explanation = `符合規則「${matchedRule.ruleName}」，但 AI 沒有產生回覆，交給人工處理。`;
      } else if (warnings.length) {
        forceHuman.push({ code: 'unchecked_reply', label: `AI 產生的回覆含有需要人工確認的內容：${warnings.map((w) => w.message).join('；')}` });
        explanation = `符合規則「${matchedRule.ruleName}」，但產生的回覆需要人工確認，交給人工處理。`;
      } else {
        decision = 'auto_replied';
        replyBody = body;
        explanation = `符合規則「${matchedRule.ruleName}」且通過安全檢查，AI 已自動回覆。`;
      }
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
  return { analysis, categoryName: cat?.name ?? analysis.categoryKey, forceHuman, knowledge, matchedRule, decision, replyBody, explanation };
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
  opts: {
    allowAutomation?: boolean;
    /** 連結帳號之前就存在的留言：不計回覆時效（不然一匯入就顯示超時好幾天） */
    historical?: boolean;
    /** 已經在平台上被本帳號回覆（例如小編直接用 App 回）：視為已回覆並完成 */
    ownReplyAt?: string | null;
  } = {},
): Promise<PipelineResult> {
  const now = nowIso();
  const postRow = await get<{ title: string; body: string }>(db, 'SELECT title, body FROM posts WHERE id = ?', [c.postId]);
  const postContext = postRow ? `${postRow.title}${postRow.body && postRow.body !== postRow.title ? `｜${postRow.body}` : ''}`.slice(0, 300) : undefined;
  const result = await decide(db, {
    postContext,
    fast: opts.historical,
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
  if (opts.allowAutomation === false && result.decision !== 'human') {
    result.decision = 'human';
    result.replyBody = null;
    result.explanation = '這是連結帳號之前就存在的留言，不自動處理，交給人工判斷。';
  }
  const a = result.analysis;

  const category = await get<{ id: number }>(db, 'SELECT id FROM comment_categories WHERE key = ?', [a.categoryKey]);
  const setting = category
    ? await get<{ sla_minutes: number | null; sla_enabled: number; handling_mode: string }>(
        db,
        'SELECT sla_minutes, sla_enabled, handling_mode FROM brand_category_settings WHERE brand_id = ? AND category_id = ?',
        [ctx.brand.id, category.id],
      )
    : undefined;
  const slaMinutes = !opts.historical && setting && setting.sla_enabled === 1 && setting.sla_minutes ? setting.sla_minutes : null;
  const slaDueAt = slaMinutes ? addMinutes(c.occurredAt, slaMinutes) : null;
  const forced = result.matchedRule?.action === 'force_human' ? result.matchedRule : null;
  const critical = !!forced || result.forceHuman.some((r) => ['sensitive', 'complaint', 'refund', 'promise', 'risk'].includes(r.code));
  // 轉人工規則指定的負責人必須是這個品牌的有效人員
  const forcedAssignee = forced?.assigneeId ? (await brandDirectory(db, ctx.brand.id)).find((u) => u.id === forced.assigneeId) ?? null : null;
  const knowledgeGap = result.knowledge.needsKnowledge && result.knowledge.hits.length === 0;

  let threadRootId: number | null = null;
  let parent: { id: number; thread_root_id: number | null; status: string; brand_id: number } | undefined;
  if (c.parentCommentId) {
    parent = await get(db, 'SELECT id, thread_root_id, status, brand_id FROM comments WHERE id = ?', [c.parentCommentId]);
    if (!parent || parent.brand_id !== ctx.brand.id) throw badRequest('被回覆的留言不存在或不屬於同一個品牌');
    threadRootId = parent.thread_root_id ?? parent.id;
  }

  const out = await tx(db, async () => {
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
      status: opts.ownReplyAt ? 'done' : 'pending',
      first_response_at: opts.ownReplyAt ?? null,
      first_response_type: opts.ownReplyAt ? 'human' : null,
      completed_at: opts.ownReplyAt ? now : null,
      priority: forced?.raisePriority ? 'high' : a.priority,
      assignee_id: forcedAssignee?.id ?? null,
      original_assignee_id: forcedAssignee?.id ?? null,
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
      provider: a.provider ?? ai.name,
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
      knowledge_hits: result.knowledge.hits.map((h) => h.id),
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

    if (opts.ownReplyAt) {
      await audit(db, {
        actorType: 'system',
        brandId: ctx.brand.id,
        commentId,
        action: 'comment.replied_on_platform',
        targetType: 'comment',
        targetId: commentId,
        summary: '這則留言已經在平台上被本帳號回覆（例如直接用 App 回覆），標示為已完成',
        after: { status: 'done' },
        detail: { ownReplyAt: opts.ownReplyAt },
      });
    }

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
      // 自動回覆在交易提交「之後」才送出：留言先存好，就算之後中斷也不會被當成新留言重複回覆
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
    } else if (forced) {
      await audit(db, {
        actorType: 'rule',
        ruleId: forced.ruleId,
        brandId: ctx.brand.id,
        commentId,
        action: 'comment.force_human',
        targetType: 'comment',
        targetId: commentId,
        summary: `轉人工規則「${forced.ruleName}」：交給人工處理${forced.raisePriority ? '，提升為高優先' : ''}${forcedAssignee ? `，指派給 ${forcedAssignee.name}` : ''}`,
        after: { priority: forced.raisePriority ? 'high' : a.priority, assigneeId: forcedAssignee?.id ?? null },
        detail: { forceHuman: result.forceHuman, matchedKeyword: forced.matchedKeyword ?? null },
      });
      if (forcedAssignee) {
        await notify(db, { userId: forcedAssignee.id, brandId: ctx.brand.id, type: 'assigned', commentId, message: `轉人工規則「${forced.ruleName}」指派一則留言給你：${c.body.slice(0, 40)}` });
      }
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
  if (out.decision === 'auto_replied' && out.replyBody && out.matchedRule) await sendAutoReply(db, ctx, c.externalId, out);
  return out;
}

/** 送出自動回覆並記錄結果（在留言已存入資料庫之後執行） */
async function sendAutoReply(db: DB, ctx: Context, externalId: string, result: PipelineResult): Promise<void> {
  const rule = result.matchedRule!;
  const commentId = result.commentId!;
  const adapter = getAdapter(ctx.account.platform);
  let sent: Awaited<ReturnType<NonNullable<typeof adapter>['replyToComment']>>;
  try {
    sent = adapter
      ? await adapter.replyToComment(await adapterAccountFor(db, { ...ctx.account, brand_id: ctx.brand.id }), { externalId, postExternalId: '' }, result.replyBody!)
      : { ok: false, error: '找不到平台 adapter' };
  } catch (err) {
    sent = { ok: false, error: (err as Error).message };
  }
  if (!sent.ok) {
    // 送出失敗就交給人工，不讓留言卡在「已自動處理」
    result.decision = 'human';
    result.explanation = `AI 自動回覆送出失敗（${sent.error}），已交給人工處理。`;
    await audit(db, {
      actorType: 'rule',
      ruleId: rule.ruleId,
      brandId: ctx.brand.id,
      commentId,
      action: 'comment.auto_reply_failed',
      targetType: 'comment',
      targetId: commentId,
      summary: result.explanation,
    });
    return;
  }
  const sentAt = nowIso();
  await tx(db, async () => {
    const replyId = await insert(db, 'replies', {
      comment_id: commentId,
      brand_id: ctx.brand.id,
      body: result.replyBody,
      source: 'auto_rule',
      ai_original_body: result.replyBody,
      was_edited: false,
      rule_id: rule.ruleId,
      status_after: 'done',
      platform_reply_id: sent.ok ? sent.externalReplyId : null,
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
      ruleId: rule.ruleId,
      brandId: ctx.brand.id,
      commentId,
      action: 'comment.auto_reply',
      targetType: 'comment',
      targetId: commentId,
      summary: `自動化規則「${rule.ruleName}」自動回覆`,
      after: { status: 'done' },
      detail: { replyId, body: result.replyBody, confidence: result.analysis.confidence },
      createdAt: sentAt,
    });
  });
}

/**
 * 透過平台 adapter 取回新留言並逐則處理（模擬器把留言放進模擬平台後呼叫；日後接真實平台也是同一個流程）。
 */
export interface SyncSummary {
  /** 平台回傳的留言總數（含已處理、略過的） */
  fetched: number;
  /** 超過時間預算、留待下次同步的留言數 */
  remaining: number;
  skippedOwn: number;
  newPosts: number;
  newComments: number;
  autoReplied: number;
  results: PipelineResult[];
}

const OPEN_STATUSES = "('pending', 'in_progress', 'transferred')";

/**
 * 修正已匯入的真實平台留言：
 * 1. 其實是本帳號自己的回覆 → 無需處理
 * 2. 已經在平台上被本帳號回覆（小編直接用 App 回）→ 已完成
 * 3. 連結帳號之前的舊留言 → 不計回覆時效
 */
async function reconcileExisting(db: DB, ctx: Context, connectedAt: string, incoming: IncomingComment[], known: Set<string>): Promise<void> {
  const now = nowIso();
  const fix = async (externalId: string, status: 'no_action' | 'done', firstResponseAt: string | null, summary: string, action: string) => {
    const row = await get<{ id: number; status: string; first_response_at: string | null }>(
      db,
      `SELECT id, status, first_response_at FROM comments WHERE social_account_id = ? AND external_id = ? AND status IN ${OPEN_STATUSES}`,
      [ctx.account.id, externalId],
    );
    if (!row) return;
    await tx(db, async () => {
      await updateById(db, 'comments', row.id, {
        status,
        completed_at: now,
        sla_due_at: status === 'no_action' ? null : undefined,
        first_response_at: !row.first_response_at && firstResponseAt ? firstResponseAt : undefined,
        first_response_type: !row.first_response_at && firstResponseAt ? 'human' : undefined,
        locked_by_id: null,
        locked_at: null,
        lock_expires_at: null,
        updated_at: now,
      });
      await audit(db, { actorType: 'system', brandId: ctx.brand.id, commentId: row.id, action, targetType: 'comment', targetId: row.id, summary, before: { status: row.status }, after: { status } });
    });
  };
  for (const item of incoming) {
    if (!known.has(item.externalId)) continue;
    if (item.isOwn) await fix(item.externalId, 'no_action', null, '這是本帳號自己的回覆，不是需要處理的留言', 'comment.own_reply_detected');
    else if (item.hasOwnReply) await fix(item.externalId, 'done', item.ownReplyAt ?? null, '已經在平台上被本帳號回覆（例如直接用 App 回覆），標示為已完成', 'comment.replied_on_platform');
  }
  await run(
    db,
    'UPDATE comments SET sla_due_at = NULL, sla_minutes = NULL WHERE social_account_id = ? AND occurred_at < ? AND first_response_at IS NULL AND sla_due_at IS NOT NULL',
    [ctx.account.id, connectedAt],
  );
}

/** 已在平台上被刪除的留言：完整取回的貼文底下沒有出現的留言，標示為已刪除並結束處理 */
async function markDeletedOnPlatform(db: DB, ctx: Context, completePostExternalIds: string[], incoming: IncomingComment[]): Promise<void> {
  if (completePostExternalIds.length === 0) return;
  const seen = new Set(incoming.map((i) => i.externalId));
  const rows = await all<{ id: number; external_id: string; status: string; post_external_id: string }>(
    db,
    `SELECT c.id, c.external_id, c.status, p.external_id AS post_external_id FROM comments c JOIN posts p ON p.id = c.post_id
     WHERE c.social_account_id = ? AND c.visibility <> 'deleted'`,
    [ctx.account.id],
  );
  const now = nowIso();
  for (const r of rows) {
    if (seen.has(r.external_id) || !completePostExternalIds.includes(r.post_external_id)) continue;
    await markDeleted(db, ctx.brand.id, r, now);
  }
}

/** 標示留言已在平台上被刪除（回覆時平台回傳找不到留言也會呼叫） */
export async function markDeleted(db: DB, brandId: number, r: { id: number; status: string }, now = nowIso()): Promise<void> {
  const open = ['pending', 'in_progress', 'transferred'].includes(r.status);
  await tx(db, async () => {
    await updateById(db, 'comments', r.id, {
      visibility: 'deleted',
      status: open ? 'no_action' : undefined,
      completed_at: open ? now : undefined,
      locked_by_id: null,
      locked_at: null,
      lock_expires_at: null,
      updated_at: now,
    });
    await audit(db, {
      actorType: 'system',
      brandId,
      commentId: r.id,
      action: 'comment.deleted_on_platform',
      targetType: 'comment',
      targetId: r.id,
      summary: `留言已在平台上被刪除${open ? '，不需要再處理' : ''}`,
      before: { status: r.status },
      after: { visibility: 'deleted', status: open ? 'no_action' : r.status },
    });
  });
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';

export async function syncAccount(db: DB, accountId: number): Promise<PipelineResult[]> {
  return (await syncAccountDetailed(db, accountId)).results;
}

/**
 * 透過平台 adapter 取回貼文與新留言並逐則處理（模擬器、真實平台共用同一個流程）。
 * 已存在的留言會略過；自己帳號發出的回覆不會當成新留言；連結帳號之前的舊留言不會自動回覆。
 */
export async function syncAccountDetailed(db: DB, accountId: number, opts: { budgetMs?: number } = {}): Promise<SyncSummary> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 20_000;
  const ctx = await loadContext(db, accountId);
  if (ctx.brand.is_active !== 1) throw badRequest('品牌已停用，無法接收新留言');
  const adapter = getAdapter(ctx.account.platform);
  if (!adapter) throw new HttpError(500, 'no_adapter', '找不到平台 adapter');
  const acct = await adapterAccountFor(db, { ...ctx.account, brand_id: ctx.brand.id });
  const cred = acct.accessToken ? await get<{ connected_at: string; username: string }>(db, 'SELECT connected_at, username FROM account_credentials WHERE account_id = ?', [accountId]) : undefined;

  let newPosts = 0;
  if (adapter.fetchPosts) {
    const now = nowIso();
    for (const p of await adapter.fetchPosts(acct)) {
      const r = await run(
        db,
        `INSERT INTO posts (brand_id, social_account_id, external_id, content_type, is_ad, ad_campaign, title, body, url, published_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (social_account_id, external_id) DO NOTHING`,
        [ctx.brand.id, ctx.account.id, p.externalId, p.contentType, p.isAd ? 1 : 0, p.adCampaign ?? null, p.title, p.body, p.url, p.publishedAt, now],
      );
      newPosts += r.changes;
    }
  }

  const incoming = await adapter.fetchComments(acct, { since: null });
  const known = new Set(
    incoming.length
      ? (await all<{ external_id: string }>(db, 'SELECT external_id FROM comments WHERE social_account_id = ?', [ctx.account.id])).map((r) => r.external_id)
      : [],
  );
  const ownName = cred?.username ? `@${cred.username}`.toLowerCase() : null;
  const results: PipelineResult[] = [];
  let skippedOwn = 0;
  let remaining = 0;
  // 連結後的新留言優先處理（需要自動回覆）；連結前的舊留言由新到舊匯入，一次處理不完就留到下次同步
  const isNew = (i: (typeof incoming)[number]) => !cred || i.occurredAt >= cred.connected_at;
  const ordered = [
    ...incoming.filter(isNew),
    ...incoming.filter((i) => !isNew(i)).sort((x, y) => y.occurredAt.localeCompare(x.occurredAt)),
  ];
  for (const item of ordered) {
    if (known.has(item.externalId)) continue;
    if (item.isOwn) {
      skippedOwn++;
      continue;
    }
    if (Date.now() - started > budgetMs) {
      remaining++;
      continue;
    }
    // 自己帳號的留言（例如系統送出的回覆）不是要處理的留言
    if (item.authorExternalId === ctx.account.external_id || (ownName && item.authorName.toLowerCase() === ownName)) {
      skippedOwn++;
      continue;
    }
    const post = await get<{ id: number }>(db, 'SELECT id FROM posts WHERE social_account_id = ? AND external_id = ?', [ctx.account.id, item.postExternalId]);
    if (!post) continue;
    const parent = item.parentExternalId
      ? await get<{ id: number }>(db, 'SELECT id FROM comments WHERE social_account_id = ? AND external_id = ?', [ctx.account.id, item.parentExternalId])
      : undefined;
    try {
      results.push(
        await processIncoming(
          db,
          ctx,
          {
            postId: post.id,
            parentCommentId: parent?.id ?? null,
            externalId: item.externalId,
            authorName: item.authorName,
            authorExternalId: item.authorExternalId,
            body: item.body,
            rating: item.rating ?? null,
            occurredAt: item.occurredAt,
          },
          {
            allowAutomation: (!cred || item.occurredAt >= cred.connected_at) && !item.hasOwnReply,
            historical: !!cred && item.occurredAt < cred.connected_at,
            ownReplyAt: item.hasOwnReply ? (item.ownReplyAt ?? item.occurredAt) : null,
          },
        ),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // 同時有另一個同步已寫入這則留言
    }
    known.add(item.externalId);
  }
  if (cred) {
    await reconcileExisting(db, ctx, cred.connected_at, incoming, known);
    await markDeletedOnPlatform(db, ctx, adapter.completePostIds?.(acct) ?? [], incoming);
  }
  await run(db, 'UPDATE social_accounts SET last_synced_at = ?, status = ? WHERE id = ?', [nowIso(), 'connected', accountId]);
  return { fetched: incoming.length, remaining, skippedOwn, newPosts, newComments: results.length, autoReplied: results.filter((r) => r.decision === 'auto_replied').length, results };
}

export { mockFeed };
