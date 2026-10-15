// 大量留言處理：相似留言分組、批次產生 AI 回覆、批次確認送出、批次標記。
// 不可妥協：批次處理時每一則留言仍各自留下 AI 建議、回覆與操作紀錄；需要個別判斷的留言不會被放進任何組。
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { all, get, insert, parseJson, sqlIn, tx, updateById } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { resolveBrandFilter } from '../auth/scope';
import { audit } from '../services/audit';
import { activeLock, assertNotLockedByOther, loadComment, releaseExpiredLocks } from '../services/comments';
import { badRequest, HttpError } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { groupComments, needsIndividualHandling, personalize } from '../ai/grouping';
import { searchKnowledge } from '../ai/knowledge';
import { checkReply, composeVariants, loadFullStyle } from '../ai/compose';
import { STATUS_LABELS, type CommentStatus, type ContentType, type Priority } from '../../shared/constants';
import type {
  BatchDraft,
  BatchItemResult,
  BatchResult,
  BatchSuggestResponse,
  CommentGroup,
  CommentGroupsResponse,
  KnowledgeHit,
  ReplyWarning,
} from '../../shared/types';
import { deliverReply } from './inbox';

/** 一批最多幾則（避免平台限流與請求逾時） */
export const BATCH_MAX = 30;
/** 批次送出的時間預算（Vercel 函式最長 60 秒） */
const SEND_BUDGET_MS = 45_000;

const OPEN_STATUSES: CommentStatus[] = ['pending', 'in_progress', 'transferred'];

interface OpenRow {
  id: number;
  brand_id: number;
  post_id: number;
  author_name: string;
  body: string;
  occurred_at: string;
  status: CommentStatus;
  priority: Priority | null;
  sla_due_at: string | null;
  first_response_at: string | null;
  risk_flags: string;
  risk_level: string | null;
  sentiment: string | null;
  locked_by_id: number | null;
  lock_expires_at: string | null;
  category_key: string | null;
  category_name: string | null;
  assignee_name: string | null;
  locked_by_name: string | null;
}

export function batchRoutes(): Router {
  const r = Router();
  r.use(requirePermission('handleComments'));

  // ---------- 相似留言分組 ----------
  r.get('/groups', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand);
    const db = req.db;
    if (brandIds.length === 0) return res.json({ groups: [], individualCount: 0, serverTime: nowIso() } satisfies CommentGroupsResponse);
    await releaseExpiredLocks(db, brandIds);
    const platform = typeof req.query.platform === 'string' && req.query.platform ? req.query.platform : null;
    const rows = await all<OpenRow>(
      db,
      `SELECT c.id, c.brand_id, c.post_id, c.author_name, c.body, c.occurred_at, c.status, c.priority, c.sla_due_at, c.first_response_at,
         c.risk_flags, c.risk_level, c.sentiment, c.locked_by_id, c.lock_expires_at,
         cc.key AS category_key, cc.name AS category_name, ua.name AS assignee_name, ul.name AS locked_by_name
       FROM comments c
       JOIN social_accounts sa ON sa.id = c.social_account_id
       LEFT JOIN comment_categories cc ON cc.id = c.category_id
       LEFT JOIN users ua ON ua.id = c.assignee_id
       LEFT JOIN users ul ON ul.id = c.locked_by_id
       WHERE ${sqlIn('c.brand_id', brandIds)} AND c.status IN (${OPEN_STATUSES.map((x) => `'${x}'`).join(', ')}) AND c.visibility = 'visible'
         AND sa.is_active = 1 ${platform ? 'AND sa.platform = ?' : ''}
       ORDER BY c.occurred_at DESC
       LIMIT 1000`,
      platform ? [platform] : [],
    );
    const { groups: raw, excludedIds } = groupComments(
      rows.map((c) => ({
        id: c.id,
        postId: c.post_id,
        categoryKey: c.category_key ?? 'other',
        body: c.body,
        riskFlags: parseJson<string[]>(c.risk_flags, []),
        riskLevel: c.risk_level,
        sentiment: c.sentiment,
      })),
    );
    const postIds = [...new Set(raw.map((g) => g.postId))];
    const posts = postIds.length
      ? await all<{ id: number; title: string; content_type: ContentType; is_ad: number; platform: string; account_name: string; brand_id: number; brand_name: string; brand_color: string }>(
          db,
          `SELECT p.id, p.title, p.content_type, p.is_ad, sa.platform, sa.name AS account_name, b.id AS brand_id, b.name AS brand_name, b.color AS brand_color
           FROM posts p JOIN social_accounts sa ON sa.id = p.social_account_id JOIN brands b ON b.id = p.brand_id WHERE ${sqlIn('p.id', postIds)}`,
        )
      : [];
    const now = nowIso();
    const byId = new Map(rows.map((c) => [c.id, c]));
    const groups: CommentGroup[] = raw.map((g) => {
      const p = posts.find((x) => x.id === g.postId)!;
      const comments = g.ids
        .map((id) => byId.get(id)!)
        .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
        .map((c) => {
          const holder = activeLock(c, now);
          return {
            id: c.id,
            authorName: c.author_name,
            body: c.body,
            occurredAt: c.occurred_at,
            status: c.status,
            priority: c.priority,
            slaDueAt: c.sla_due_at,
            firstResponseAt: c.first_response_at,
            categoryName: c.category_name,
            assigneeName: c.assignee_name,
            lockedByName: holder && holder !== user.id ? c.locked_by_name : null,
          };
        });
      const dues = comments.filter((c) => !c.firstResponseAt && c.slaDueAt).map((c) => c.slaDueAt!).sort();
      return {
        key: g.key,
        intentKey: g.intentKey,
        label: g.label,
        replyable: g.replyable,
        brandId: p.brand_id,
        brandName: p.brand_name,
        brandColor: p.brand_color,
        postId: p.id,
        postTitle: p.title,
        contentType: p.content_type,
        isAd: p.is_ad === 1,
        platform: p.platform,
        accountName: p.account_name,
        earliestDueAt: dues[0] ?? null,
        comments,
      };
    });
    // 最急的組（最早到期）排前面，其次是數量多的
    groups.sort((a, b) => (a.earliestDueAt ?? '9').localeCompare(b.earliestDueAt ?? '9') || b.comments.length - a.comments.length);
    res.json({ groups, individualCount: excludedIds.length, serverTime: now } satisfies CommentGroupsResponse);
  });

  // ---------- 批次產生 AI 回覆 ----------
  const suggestSchema = z.object({
    commentIds: z.array(z.number().int().positive()).min(1, '請至少選擇一則留言').max(BATCH_MAX, `一次最多 ${BATCH_MAX} 則`),
    variantKey: z.string().max(30).optional(),
  });
  r.post('/suggest', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = suggestSchema.parse(req.body);
    const db = req.db;
    const ids = [...new Set(input.commentIds)];
    const rows = await all<{ id: number; brand_id: number; author_name: string; body: string; status: CommentStatus; visibility: string; risk_flags: string; risk_level: string | null; sentiment: string | null; category_id: number | null; category_key: string | null; category_name: string | null }>(
      db,
      `SELECT c.id, c.brand_id, c.author_name, c.body, c.status, c.visibility, c.risk_flags, c.risk_level, c.sentiment, c.category_id, cc.key AS category_key, cc.name AS category_name
       FROM comments c LEFT JOIN comment_categories cc ON cc.id = c.category_id WHERE ${sqlIn('c.id', ids)}`,
    );
    const visible = rows.filter((c) => scope.activeBrandIds.includes(c.brand_id));
    if (visible.length !== ids.length) throw badRequest('有留言不存在或你沒有權限處理');
    const brandIds = [...new Set(visible.map((c) => c.brand_id))];
    if (brandIds.length > 1) throw badRequest('批次回覆只能選同一個品牌的留言');
    const brandId = brandIds[0];
    const brand = (await get<{ id: number; name: string }>(db, 'SELECT id, name FROM brands WHERE id = ?', [brandId]))!;

    const skipped: BatchSuggestResponse['skipped'] = [];
    const usable = ids
      .map((id) => visible.find((c) => c.id === id)!)
      .filter((c) => {
        const reason =
          c.visibility === 'deleted' ? '留言已刪除'
          : c.status === 'done' || c.status === 'no_action' ? '已經處理完成'
          : needsIndividualHandling({ categoryKey: c.category_key ?? 'other', riskFlags: parseJson<string[]>(c.risk_flags, []), riskLevel: c.risk_level, sentiment: c.sentiment })
            ? '涉及客訴、退款、敏感或風險，需要個別處理'
            : null;
        if (reason) skipped.push({ commentId: c.id, reason });
        return !reason;
      });
    if (usable.length === 0) throw badRequest(skipped[0]?.reason ? `沒有可以批次回覆的留言：${skipped[0].reason}` : '沒有可以批次回覆的留言');

    // 這批共用同一份知識：先以最常見的類型、找第一則查得到知識的留言，確保每則回覆的事實一致
    const counts = new Map<string, number>();
    for (const c of usable) counts.set(c.category_key ?? 'other', (counts.get(c.category_key ?? 'other') ?? 0) + 1);
    const categoryKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const categoryName = usable.find((c) => c.category_key === categoryKey)?.category_name ?? categoryKey;
    let kn = await searchKnowledge(db, { brandId, body: usable[0].body, categoryKey, categoryName });
    for (const c of usable.slice(1)) {
      if (kn.hits.length) break;
      kn = await searchKnowledge(db, { brandId, body: c.body, categoryKey, categoryName });
    }
    const hits: KnowledgeHit[] = kn.hits;
    const knowledgeGap = kn.needsKnowledge && hits.length === 0;
    const style = await loadFullStyle(db, brandId);
    const enabled = style.variants.filter((v) => v.enabled);
    const variantKey = enabled.find((v) => v.key === input.variantKey)?.key ?? enabled.find((v) => v.key !== 'lively')?.key ?? enabled[0]?.key ?? 'friendly';

    const notes: string[] = [];
    if (knowledgeGap) notes.push('知識不足：知識庫找不到可引用的資料，回覆不包含價格、規格等事實。建議先補上知識，或確認後再送出。');
    if (hits.length) notes.push(`這批回覆都引用同一份知識（${hits.map((h) => `「${h.title}」`).join('、')}），事實內容一致，只調整開頭與語氣。`);
    if (skipped.length) notes.push(`${skipped.length} 則留言不適合批次回覆，已排除，請個別處理。`);

    const batchId = randomUUID();
    const now = nowIso();
    const drafts: BatchDraft[] = [];
    const seen = new Set<string>();
    await tx(db, async () => {
      for (const [i, c] of usable.entries()) {
        // 措辭變化：不同 seed 換表情與結語，再加上不同的稱呼開頭；若還是重複就換下一個 seed
        let body = '';
        let knowledgeIds: number[] = [];
        for (let attempt = 0; attempt < 6; attempt++) {
          const v = composeVariants({
            body: c.body,
            categoryKey,
            riskFlags: parseJson<string[]>(c.risk_flags, []),
            sentiment: c.sentiment,
            brandName: brand.name,
            style,
            hits,
            needsKnowledge: kn.needsKnowledge,
            seed: c.id * 7 + i + attempt * 5,
          });
          const picked = v.find((x) => x.key === variantKey) ?? v[0];
          body = personalize(picked?.body ?? '', c.author_name, i + attempt, style.addressing);
          knowledgeIds = picked?.knowledgeIds ?? [];
          if (!seen.has(body)) break;
        }
        seen.add(body);
        const round = ((await get<{ r: number | null }>(db, 'SELECT MAX(generation_round) AS r FROM ai_suggestions WHERE comment_id = ?', [c.id]))?.r ?? 0) + 1;
        const analysis = await get<{ id: number }>(db, 'SELECT id FROM ai_analyses WHERE comment_id = ? ORDER BY id DESC LIMIT 1', [c.id]);
        const suggestionId = await insert(db, 'ai_suggestions', {
          comment_id: c.id,
          brand_id: brandId,
          analysis_id: analysis?.id ?? null,
          variant_key: variantKey,
          variant_label: `${enabled.find((v) => v.key === variantKey)?.label ?? variantKey}（批次）`,
          body,
          knowledge_ids: knowledgeIds,
          generation_round: round,
          requested_by_id: user.id,
          created_at: now,
        });
        await audit(db, {
          actorType: 'ai',
          actorUserId: user.id,
          brandId,
          commentId: c.id,
          action: 'ai.suggest',
          targetType: 'comment',
          targetId: c.id,
          summary: `AI 批次產生回覆建議（同批 ${usable.length} 則${knowledgeGap ? '，知識不足' : hits.length ? `，引用 ${hits.length} 則知識` : ''}）`,
          detail: { batchId, round, knowledgeIds, knowledgeGap },
        });
        drafts.push({ commentId: c.id, authorName: c.author_name, commentBody: c.body, suggestionId, body, warnings: await checkReply(db, brandId, body, style) });
      }
    });
    const body: BatchSuggestResponse = {
      batchId,
      variantKey,
      variants: enabled.map((v) => ({ key: v.key, label: v.label })),
      knowledgeGap,
      hits,
      notes,
      drafts,
      skipped,
    };
    res.json(body);
  });

  // ---------- 批次確認送出 ----------
  const replySchema = z.object({
    batchId: z.string().max(60).optional(),
    statusAfter: z.enum(['waiting', 'done'], { errorMap: () => ({ message: '請選擇回覆後的狀態：等待對方或已完成' }) }),
    confirmWarnings: z.boolean().optional(),
    items: z
      .array(
        z.object({
          commentId: z.number().int().positive(),
          body: z.string().trim().min(1, '回覆內容不可空白').max(2000, '回覆最多 2000 個字'),
          suggestionId: z.number().int().positive().nullable().optional(),
        }),
      )
      .min(1, '請至少選擇一則留言')
      .max(BATCH_MAX, `一次最多 ${BATCH_MAX} 則`),
  });
  r.post('/reply', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = replySchema.parse(req.body);
    const db = req.db;
    if (new Set(input.items.map((i) => i.commentId)).size !== input.items.length) throw badRequest('同一則留言不可重複送出');

    // 送出前逐則檢查；有禁用詞就整批不送，有需確認的提醒就先請人工確認
    const checked: Array<{ commentId: number; warnings: ReplyWarning[] }> = [];
    for (const item of input.items) {
      const c = await loadComment(db, scope, item.commentId);
      checked.push({ commentId: c.id, warnings: await checkReply(db, c.brand_id, item.body) });
    }
    const blocked = checked.filter((x) => x.warnings.some((w) => w.level === 'block'));
    if (blocked.length) throw new HttpError(422, 'reply_blocked', `${blocked.length} 則回覆含有品牌禁用詞，請修改後再送出`, { items: blocked });
    const toConfirm = checked.filter((x) => x.warnings.length);
    if (toConfirm.length && !input.confirmWarnings) throw new HttpError(422, 'reply_warnings', `${toConfirm.length} 則回覆有需要確認的提醒`, { items: toConfirm });

    const batchId = input.batchId || randomUUID();
    const started = Date.now();
    const results: BatchItemResult[] = [];
    for (const item of input.items) {
      if (Date.now() - started > SEND_BUDGET_MS) {
        results.push({ commentId: item.commentId, ok: false, error: '這次送出時間不夠，尚未送出，請再送一次' });
        continue;
      }
      try {
        await deliverReply(db, user, scope, item.commentId, {
          body: item.body,
          statusAfter: input.statusAfter,
          suggestionId: item.suggestionId ?? null,
          warnings: checked.find((x) => x.commentId === item.commentId)?.warnings ?? [],
          batch: { id: batchId, size: input.items.length },
        });
        results.push({ commentId: item.commentId, ok: true });
      } catch (err) {
        results.push({ commentId: item.commentId, ok: false, error: (err as Error).message });
      }
    }
    const body: BatchResult = { batchId, results, succeeded: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length };
    res.status(201).json(body);
  });

  // ---------- 批次標記（無需處理／已完成） ----------
  const statusSchema = z.object({
    commentIds: z.array(z.number().int().positive()).min(1, '請至少選擇一則留言').max(100, '一次最多 100 則'),
    status: z.enum(['no_action', 'done'], { errorMap: () => ({ message: '批次只能標記為「無需處理」或「已完成」' }) }),
    reason: z.string().trim().max(300).optional(),
  });
  r.post('/status', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = statusSchema.parse(req.body);
    const db = req.db;
    const ids = [...new Set(input.commentIds)];
    const batchId = randomUUID();
    const results: BatchItemResult[] = [];
    for (const id of ids) {
      try {
        await tx(db, async () => {
          const c = await loadComment(db, scope, id);
          await assertNotLockedByOther(db, c, user);
          if (c.status === input.status) return;
          if (input.status === 'done' && !c.first_response_at && c.status !== 'waiting') {
            throw badRequest('還沒有回覆過，不能直接標示為「已完成」；不需要回覆請標示「無需處理」');
          }
          const now = nowIso();
          await updateById(db, 'comments', c.id, {
            status: input.status,
            completed_at: now,
            handled_by_id: user.id,
            locked_by_id: null,
            locked_at: null,
            lock_expires_at: null,
            updated_at: now,
          });
          await audit(db, {
            actorType: 'user',
            actorUserId: user.id,
            brandId: c.brand_id,
            commentId: c.id,
            action: 'comment.status_change',
            targetType: 'comment',
            targetId: c.id,
            assigneeIdAtTime: c.assignee_id,
            summary: `${user.name} 批次（${ids.length} 則）將狀態由「${STATUS_LABELS[c.status]}」改為「${STATUS_LABELS[input.status]}」${input.reason ? `：${input.reason}` : ''}`,
            before: { status: c.status },
            after: { status: input.status },
            detail: { batchId, batchSize: ids.length, reason: input.reason },
          });
        });
        results.push({ commentId: id, ok: true });
      } catch (err) {
        results.push({ commentId: id, ok: false, error: (err as Error).message });
      }
    }
    const body: BatchResult = { batchId, results, succeeded: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length };
    res.json(body);
  });

  return r;
}
