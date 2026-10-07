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

export function createSession(db: DB, userId: number): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('hex');
  const now = nowIso();
  const expiresAt = addMinutes(now, config.sessionTtlHours * 60);
  run(db, `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`, [
    hashToken(token),
    userId,
    now,
    expiresAt,
    now,
  ]);
  return { token, expiresAt };
}

/** 依 token 取得登入者；過期或帳號停用則回傳 null。有效期間會隨使用自動延長（每 5 分鐘最多更新一次）。 */
export function getSessionUser(db: DB, token: string | undefined): AuthUser | null {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = get<{
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
    run(db, 'DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
    return null;
  }
  if (Date.parse(now) - Date.parse(row.last_seen_at) > 5 * 60_000) {
    run(db, 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?', [
      now,
      addMinutes(now, config.sessionTtlHours * 60),
      tokenHash,
    ]);
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role, isActive: true };
}

export function destroySession(db: DB, token: string | undefined): void {
  if (!token) return;
  run(db, 'DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

export function destroyUserSessions(db: DB, userId: number): void {
  run(db, 'DELETE FROM sessions WHERE user_id = ?', [userId]);
}
