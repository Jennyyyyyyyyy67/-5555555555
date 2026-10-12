import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { all, get, insert, run, sqlIn, tx, type DB } from '../db';
import { SESSION_COOKIE } from '../config';
import { authed, requirePermission } from '../auth/middleware';
import { computeScope } from '../auth/scope';
import { createSession, type AuthUser } from '../auth/session';
import { resetAllLoginFailures } from '../auth/rateLimit';
import { audit } from '../services/audit';
import { badRequest } from '../lib/errors';
import { resetAndSeed } from '../seed';
import { buildMe, setSessionCookie } from './auth';
import type { CommentStatus } from '../../shared/constants';
import type { MockResetResponse, MockStatsResponse } from '../../shared/types';

const resetSchema = z.object({ confirm: z.literal(true) });

async function count(db: DB, table: string): Promise<number> {
  return (await get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0;
}

async function buildStats(db: DB, brandIds: number[]): Promise<MockStatsResponse> {
  const seededAt = (await get<{ value: string | null }>(db, "SELECT value FROM schema_meta WHERE key = 'seeded_at'"))?.value ?? null;

  const brands = await all<{ id: number; name: string; color: string; accounts: number; posts: number; comments: number }>(
    db,
    `SELECT b.id, b.name, b.color,
       (SELECT COUNT(*) FROM social_accounts sa WHERE sa.brand_id = b.id) AS accounts,
       (SELECT COUNT(*) FROM posts p WHERE p.brand_id = b.id) AS posts,
       (SELECT COUNT(*) FROM comments c WHERE c.brand_id = b.id) AS comments
     FROM brands b WHERE ${sqlIn('b.id', brandIds)} ORDER BY b.id`,
  );
  const byPlatform = await all<{ brand_id: number; platform: string; n: number }>(
    db,
    `SELECT c.brand_id, sa.platform, COUNT(*) AS n
     FROM comments c JOIN social_accounts sa ON sa.id = c.social_account_id
     WHERE ${sqlIn('c.brand_id', brandIds)}
     GROUP BY c.brand_id, sa.platform ORDER BY sa.platform`,
  );
  const byStatus = await all<{ brand_id: number; status: CommentStatus; n: number }>(
    db,
    `SELECT c.brand_id, c.status, COUNT(*) AS n FROM comments c
     WHERE ${sqlIn('c.brand_id', brandIds)} GROUP BY c.brand_id, c.status`,
  );

  return {
    seededAt,
    totals: {
      brands: await count(db, 'brands'),
      users: await count(db, 'users'),
      accounts: await count(db, 'social_accounts'),
      posts: await count(db, 'posts'),
      comments: await count(db, 'comments'),
      replies: await count(db, 'replies'),
      auditLogs: await count(db, 'audit_logs'),
    },
    byBrand: brands.map((b) => {
      const platforms: Record<string, number> = {};
      for (const r of byPlatform) if (r.brand_id === b.id) platforms[r.platform] = r.n;
      const statuses: Partial<Record<CommentStatus, number>> = {};
      for (const r of byStatus) if (r.brand_id === b.id) statuses[r.status] = r.n;
      return {
        brandId: b.id,
        brandName: b.name,
        brandColor: b.color,
        accounts: b.accounts,
        posts: b.posts,
        comments: b.comments,
        byPlatform: platforms,
        byStatus: statuses,
      };
    }),
  };
}

export function mockRoutes(): Router {
  const r = Router();

  // 資料量統計（只有管理員可看；管理員的品牌範圍即為全部品牌）
  r.get('/stats', requirePermission('manageMockData'), async (req: Request, res: Response) => {
    const { scope } = authed(req);
    res.json(await buildStats(req.db, scope.brandIds));
  });

  // 清空所有資料並重新建立示範資料
  r.post('/reset', requirePermission('manageMockData'), async (req: Request, res: Response) => {
    const { user } = authed(req);
    if (!resetSchema.safeParse(req.body ?? {}).success) {
      throw badRequest('請確認要重設示範資料：重設會清空所有資料，確認後請再送出一次');
    }
    const db = req.db;
    const requester = { name: user.name, email: user.email };

    // resetAndSeed 會 DROP 所有資料表（含 sessions、users）後重建，不能包在外層交易中
    // （交易中無法關閉外鍵檢查）；示範資料本身在 resetAndSeed 內以交易建立。
    // 保留已連結的真實平台帳號（例如 Instagram），重設後不用重新登入授權
    const live = await all<{
      brand_code: string; platform: string; account_type: string; name: string; handle: string; external_id: string; adapter_key: string;
      provider: string; access_token_enc: string; token_expires_at: string | null; scopes: string; platform_user_id: string; username: string;
    }>(
      db,
      `SELECT b.code AS brand_code, a.platform, a.account_type, a.name, a.handle, a.external_id, a.adapter_key,
              c.provider, c.access_token_enc, c.token_expires_at, c.scopes, c.platform_user_id, c.username
       FROM account_credentials c JOIN social_accounts a ON a.id = c.account_id JOIN brands b ON b.id = a.brand_id`,
    ).catch(() => []);

    const summary = await resetAndSeed(db);
    resetAllLoginFailures();
    if (live.length) {
      const now = new Date().toISOString();
      await tx(db, async () => {
        for (const l of live) {
          const brand =
            (await get<{ id: number }>(db, 'SELECT id FROM brands WHERE code = ?', [l.brand_code])) ??
            (await get<{ id: number }>(db, 'SELECT id FROM brands WHERE is_active = 1 ORDER BY id LIMIT 1'));
          if (!brand) continue;
          const accountId = await insert(db, 'social_accounts', {
            brand_id: brand.id,
            platform: l.platform,
            account_type: l.account_type,
            name: l.name,
            handle: l.handle,
            external_id: l.external_id,
            adapter_key: l.adapter_key,
            status: 'connected',
            is_active: true,
            created_at: now,
            updated_at: now,
          });
          // 連結時間設為現在：重新匯入的舊留言不會再被自動回覆一次
          await run(
            db,
            `INSERT INTO account_credentials (account_id, provider, access_token_enc, token_expires_at, scopes, platform_user_id, username, connected_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [accountId, l.provider, l.access_token_enc, l.token_expires_at, l.scopes, l.platform_user_id, l.username, now, now],
          );
        }
      });
    }

    // 舊的 session 已隨資料表一起清除；若同一個 Email 仍存在於示範資料中，就幫他建立新的登入狀態
    const row = await get<{ id: number; name: string; email: string; role: AuthUser['role']; is_active: number }>(
      db,
      'SELECT id, name, email, role, is_active FROM users WHERE lower(email) = lower(?)',
      [requester.email],
    );
    const newUser: AuthUser | null =
      row && row.is_active === 1 ? { id: row.id, name: row.name, email: row.email, role: row.role, isActive: true } : null;

    const session = await tx(db, async () => {
      if (newUser) {
        const s = await createSession(db, newUser.id);
        await audit(db, {
          actorType: 'user',
          actorUserId: newUser.id,
          action: 'mock.reset',
          targetType: 'system',
          summary: '重設示範資料',
          detail: summary,
        });
        return s;
      }
      await audit(db, {
        actorType: 'system',
        action: 'mock.reset',
        targetType: 'system',
        summary: `重設示範資料（由 ${requester.name}〈${requester.email}〉執行；此帳號不在示範資料中，已登出）`,
        detail: { ...summary, requestedBy: requester },
      });
      return null;
    });

    if (newUser && session) {
      setSessionCookie(res, session.token, session.expiresAt);
      const body: MockResetResponse = { summary, me: await buildMe(db, newUser, await computeScope(db, newUser)) };
      res.json(body);
      return;
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    const body: MockResetResponse = { summary, me: null };
    res.json(body);
  });

  return r;
}
