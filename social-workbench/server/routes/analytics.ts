// 數據看板、異常事件、社群洞察與報表（管理員、企業負責人、主管）。
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { all, get, insert, parseJson, sqlIn, tx, updateById } from '../db';
import { authed, requirePermission } from '../auth/middleware';
import { assertBrandAccess, resolveBrandFilter } from '../auth/scope';
import { audit } from '../services/audit';
import { nowIso } from '../lib/clock';
import { badRequest } from '../lib/errors';
import { PLATFORM_LABELS } from '../../shared/constants';
import {
  aiMetrics,
  buildInsights,
  communityMetrics,
  comparison,
  countToday,
  dailySeries,
  dayStart,
  detectAnomalies,
  highlights,
  loadComments,
  loadOpenNow,
  loadPeriod,
  opsMetrics,
  parseRange,
  previousRange,
  teamMetrics,
} from '../services/analytics';
import type { DB } from '../db';
import type { AnomaliesResponse, AnomalyEvent, DashboardResponse, InsightsResponse, ReportResponse } from '../../shared/types';

const platformLabel = (p: string) => PLATFORM_LABELS[p] ?? p;
const DAY = 86_400_000;

/** 依參考時間偵測異常（rows 需涵蓋參考時間前 15 天），並附上已處理紀錄 */
async function attachAcks(db: DB, brandIds: number[], events: Array<Omit<AnomalyEvent, 'ack'>>): Promise<AnomalyEvent[]> {
  if (events.length === 0) return [];
  const acks = await all<{ dedupe_key: string; metrics: string; acknowledged_at: string; name: string | null }>(
    db,
    `SELECT e.dedupe_key, e.metrics, e.acknowledged_at, u.name FROM anomaly_events e LEFT JOIN users u ON u.id = e.acknowledged_by_id
     WHERE ${sqlIn('e.brand_id', brandIds)} AND e.status = 'resolved'`,
  );
  return events.map((e) => {
    const a = acks.find((x) => x.dedupe_key === e.key);
    return { ...e, ack: a ? { userName: a.name ?? '', note: parseJson<{ note?: string }>(a.metrics, {}).note ?? '', createdAt: a.acknowledged_at } : null };
  });
}

async function anomaliesAt(db: DB, brandIds: number[], refIso: string): Promise<AnomalyEvent[]> {
  const ref = Date.parse(refIso);
  const rows = await loadComments(db, brandIds, new Date(ref - 15 * DAY).toISOString(), new Date(ref + 1).toISOString());
  return attachAcks(db, brandIds, detectAnomalies(rows, refIso));
}

export function analyticsRoutes(): Router {
  const r = Router();
  r.use(requirePermission('viewDashboard'));

  r.get('/dashboard', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand);
    const range = parseRange(req.query.from, req.query.to);
    const { rows, replies, suggestions } = await loadPeriod(req.db, brandIds, range);
    const [openNow, today, team] = await Promise.all([loadOpenNow(req.db, brandIds), countToday(req.db, brandIds), teamMetrics(req.db, rows, replies, brandIds)]);
    const body: DashboardResponse = {
      range,
      brandIds,
      ops: opsMetrics(rows, openNow, today),
      ai: aiMetrics(rows, replies, suggestions),
      community: communityMetrics(rows, platformLabel),
      team,
      daily: dailySeries(rows, replies, range),
      serverTime: nowIso(),
    };
    res.json(body);
  });

  r.get('/anomalies', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand);
    const now = nowIso();
    res.json({ events: await anomaliesAt(req.db, brandIds, now), serverTime: now } satisfies AnomaliesResponse);
  });

  const ackSchema = z.object({
    key: z.string().min(1).max(200),
    brandId: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    type: z.string().max(40),
    note: z.string().trim().max(300).optional(),
  });
  r.post('/anomalies/ack', async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const input = ackSchema.parse(req.body);
    assertBrandAccess(scope, input.brandId);
    if (input.key.split(':')[1] !== String(input.brandId)) throw badRequest('事件與品牌不符');
    const now = nowIso();
    await tx(req.db, async () => {
      const existing = await get<{ id: number }>(req.db, 'SELECT id FROM anomaly_events WHERE dedupe_key = ? AND brand_id = ?', [input.key, input.brandId]);
      const data = {
        status: 'resolved',
        metrics: { note: input.note ?? '' },
        acknowledged_by_id: user.id,
        acknowledged_at: now,
        resolved_by_id: user.id,
        resolved_at: now,
        updated_at: now,
      };
      if (existing) await updateById(req.db, 'anomaly_events', existing.id, data);
      else await insert(req.db, 'anomaly_events', { brand_id: input.brandId, type: input.type, title: input.title, severity: 'medium', dedupe_key: input.key, detected_at: now, ...data });
      await audit(req.db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: input.brandId,
        action: 'anomaly.resolve',
        targetType: 'anomaly',
        summary: `${user.name} 將異常事件「${input.title}」標記為已處理${input.note ? `：${input.note}` : ''}`,
        detail: { key: input.key, note: input.note },
      });
    });
    res.status(204).end();
  });

  r.get('/insights', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand);
    const range = parseRange(req.query.from, req.query.to, 30);
    const { rows } = await loadPeriod(req.db, brandIds, range);
    res.json({ range, totalComments: rows.length, sections: buildInsights(rows, platformLabel) } satisfies InsightsResponse);
  });

  r.get('/report', async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const brandIds = resolveBrandFilter(scope, req.query.brand);
    const range = parseRange(req.query.from, req.query.to);
    const previous = previousRange(range);
    const [cur, prev, openNow, today] = await Promise.all([
      loadPeriod(req.db, brandIds, range),
      loadPeriod(req.db, brandIds, previous),
      loadOpenNow(req.db, brandIds),
      countToday(req.db, brandIds),
    ]);
    const now = nowIso();
    const endIso = new Date(Math.min(Date.parse(now), dayStart(range.to) + DAY - 1)).toISOString();
    // 範圍內每天結束時偵測一次（最多 31 天），合併成這段期間發生過的異常事件
    const seen = new Map<string, Omit<AnomalyEvent, 'ack'>>();
    const days = Math.min(31, Math.round((Date.parse(endIso) - dayStart(range.from)) / DAY) + 1);
    const pool = await loadComments(req.db, brandIds, new Date(Date.parse(endIso) - (days + 15) * DAY).toISOString(), new Date(Date.parse(endIso) + 1).toISOString());
    for (let i = 0; i < days; i++) {
      const ref = new Date(Date.parse(endIso) - i * DAY).toISOString();
      for (const e of detectAnomalies(pool, ref)) {
        const k = e.key.split(':').slice(0, 3).join(':');
        if (!seen.has(k)) seen.set(k, e);
      }
    }
    const anomalies = await attachAcks(req.db, brandIds, [...seen.values()]);
    const ops = opsMetrics(cur.rows, openNow, today);
    const previousOps = opsMetrics(prev.rows, [], 0);
    const ai = aiMetrics(cur.rows, cur.replies, cur.suggestions);
    const community = communityMetrics(cur.rows, platformLabel);
    const brandOf = new Map(cur.rows.map((c) => [c.id, c]));
    const platformOfReply = new Map(cur.rows.map((c) => [c.id, c.platform]));
    const body: ReportResponse = {
      range,
      previous,
      ops,
      ai,
      previousOps,
      previousAi: aiMetrics(prev.rows, prev.replies, prev.suggestions),
      community,
      daily: dailySeries(cur.rows, cur.replies, range),
      brands: comparison(cur.rows, cur.replies, (c) => [String(c.brand_id), c.brand_name], (x) => String(x.brand_id)),
      platforms: comparison(cur.rows, cur.replies, (c) => [c.platform, platformLabel(c.platform)], (x) => platformOfReply.get(x.comment_id) ?? (brandOf.get(x.comment_id)?.platform ?? null)),
      anomalies,
      insights: buildInsights(cur.rows, platformLabel),
      highlights: highlights(ops, previousOps, ai, community, anomalies),
      generatedAt: now,
    };
    res.json(body);
  });

  return r;
}
