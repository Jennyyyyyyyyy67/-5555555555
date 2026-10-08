import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { all, get, run, sqlIn, type DB } from '../db';
import { config, SESSION_COOKIE } from '../config';
import { verifyPassword } from '../auth/password';
import { createSession, destroySession, type AuthUser } from '../auth/session';
import { computeScope, type BrandScope } from '../auth/scope';
import { authed, requireAuth } from '../auth/middleware';
import { clearLoginFailures, isLoginLocked, recordLoginFailure } from '../auth/rateLimit';
import { audit } from '../services/audit';
import { HttpError } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { DEMO_PASSWORD, DEMO_USERS } from '../seed/demo';
import type { BrandSummary, DemoAccountsResponse, MeResponse } from '../../shared/types';

export async function buildMe(db: DB, user: AuthUser, scope: BrandScope): Promise<MeResponse> {
  const rows = await all<{ id: number; name: string; code: string; color: string; is_active: number }>(
    db,
    `SELECT id, name, code, color, is_active FROM brands WHERE ${sqlIn('id', scope.brandIds)} ORDER BY id`,
  );
  const brands: BrandSummary[] = rows.map((b) => ({
    id: b.id,
    name: b.name,
    code: b.code,
    color: b.color,
    isActive: b.is_active === 1,
  }));
  return { user: { id: user.id, name: user.name, email: user.email, role: user.role }, brands };
}

export function setSessionCookie(res: Response, token: string, expiresAt: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    expires: new Date(expiresAt),
  });
}

const loginSchema = z.object({
  email: z.string().trim().min(1, '請輸入 Email').max(200),
  password: z.string().min(1, '請輸入密碼').max(200),
});

export function authRoutes(): Router {
  const r = Router();

  r.post('/login', async (req: Request, res: Response) => {
    const { email, password } = loginSchema.parse(req.body);
    const db = req.db;
    if (isLoginLocked(email)) {
      throw new HttpError(429, 'too_many_attempts', '登入失敗次數過多，請 10 分鐘後再試');
    }
    const row = await get<{ id: number; name: string; email: string; role: AuthUser['role']; is_active: number; password_hash: string }>(
      db,
      'SELECT id, name, email, role, is_active, password_hash FROM users WHERE lower(email) = lower(?)',
      [email],
    );
    if (!row || row.is_active !== 1 || !verifyPassword(password, row.password_hash)) {
      recordLoginFailure(email);
      await audit(db, {
        actorType: 'system',
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: row?.id ?? null,
        summary: row && row.is_active !== 1 ? `已停用帳號嘗試登入：${email}` : `登入失敗：${email}`,
        detail: { email },
      });
      throw new HttpError(401, 'invalid_credentials', row && row.is_active !== 1 ? '此帳號已停用，請聯絡管理員' : 'Email 或密碼錯誤');
    }
    clearLoginFailures(email);
    const user: AuthUser = { id: row.id, name: row.name, email: row.email, role: row.role, isActive: true };
    const session = await createSession(db, user.id);
    await run(db, 'UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
    await audit(db, {
      actorType: 'user',
      actorUserId: user.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      summary: `${user.name} 登入`,
    });
    setSessionCookie(res, session.token, session.expiresAt);
    res.json(await buildMe(db, user, await computeScope(db, user)));
  });

  r.post('/logout', async (req: Request, res: Response) => {
    if (req.user) {
      await audit(req.db, {
        actorType: 'user',
        actorUserId: req.user.id,
        action: 'auth.logout',
        targetType: 'user',
        targetId: req.user.id,
        summary: `${req.user.name} 登出`,
      });
    }
    await destroySession(req.db, req.sessionToken);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  r.get('/me', requireAuth(), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    res.json(await buildMe(req.db, user, scope));
  });

  // 示範模式：列出示範帳號（只列出目前仍存在且啟用的帳號）
  r.get('/demo-accounts', async (req: Request, res: Response) => {
    if (!config.demoMode) {
      res.json({ enabled: false, accounts: [] } satisfies DemoAccountsResponse);
      return;
    }
    const accounts: DemoAccountsResponse['accounts'] = [];
    for (const d of DEMO_USERS) {
      const u = await get<{ id: number; name: string; role: AuthUser['role']; is_active: number }>(
        req.db,
        'SELECT id, name, role, is_active FROM users WHERE lower(email) = lower(?)',
        [d.email],
      );
      if (!u || u.is_active !== 1) continue;
      const brandNames =
        u.role === 'admin'
          ? ['全部品牌']
          : (await all<{ name: string }>(
              req.db,
              `SELECT b.name FROM user_brands ub JOIN brands b ON b.id = ub.brand_id WHERE ub.user_id = ? AND b.is_active = 1 ORDER BY b.id`,
              [u.id],
            )).map((b) => b.name);
      accounts.push({ email: d.email, password: DEMO_PASSWORD, name: u.name, role: u.role, brandNames });
    }
    res.json({ enabled: true, accounts } satisfies DemoAccountsResponse);
  });

  return r;
}
