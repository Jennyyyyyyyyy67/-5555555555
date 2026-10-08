import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db';
import { get, run } from '../db';
import { addMinutes, nowIso } from '../lib/clock';
import { config } from '../config';
import type { Role } from '../../shared/constants';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(db: DB, userId: number): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString('hex');
  const now = nowIso();
  const expiresAt = addMinutes(now, config.sessionTtlHours * 60);
  await run(db, `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`, [
    hashToken(token),
    userId,
    now,
    expiresAt,
    now,
  ]);
  return { token, expiresAt };
}

/** 依 token 取得登入者；過期或帳號停用則回傳 null。有效期間會隨使用自動延長（每 5 分鐘最多更新一次）。 */
export async function getSessionUser(db: DB, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = await get<{
    id: number;
    name: string;
    email: string;
    role: Role;
    is_active: number;
    expires_at: string;
    last_seen_at: string;
  }>(
    db,
    `SELECT u.id, u.name, u.email, u.role, u.is_active, s.expires_at, s.last_seen_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    [tokenHash],
  );
  if (!row) return null;
  const now = nowIso();
  if (row.expires_at <= now || row.is_active !== 1) {
    await run(db, 'DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
    return null;
  }
  if (Date.parse(now) - Date.parse(row.last_seen_at) > 5 * 60_000) {
    await run(db, 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?', [
      now,
      addMinutes(now, config.sessionTtlHours * 60),
      tokenHash,
    ]);
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role, isActive: true };
}

export async function destroySession(db: DB, token: string | undefined): Promise<void> {
  if (!token) return;
  await run(db, 'DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

/**
 * 登出某人員的所有裝置，回傳刪除的 session 數。
 * exceptToken：保留這個登入狀態（例如管理員重設自己的密碼時，保留目前的裝置）。
 */
export async function destroyUserSessions(db: DB, userId: number, opts: { exceptToken?: string } = {}): Promise<number> {
  if (opts.exceptToken) {
    return (await run(db, 'DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [userId, hashToken(opts.exceptToken)])).changes;
  }
  return (await run(db, 'DELETE FROM sessions WHERE user_id = ?', [userId])).changes;
}
