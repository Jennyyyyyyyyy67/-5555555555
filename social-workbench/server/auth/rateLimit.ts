// 登入／註冊失敗次數限制。存在資料庫，Vercel 多個執行個體、冷啟動都共用同一份計數。
import type { DB } from '../db';
import { get, run } from '../db';

const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_FAILURES = 5;
const SIGNUP_WINDOW_MS = 60 * 60_000;
const SIGNUP_MAX = 5;

const since = (ms: number, nowMs: number) => new Date(nowMs - ms).toISOString();

async function count(db: DB, key: string, windowMs: number, nowMs: number): Promise<number> {
  const row = await get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ? AND at > ?', [key, since(windowMs, nowMs)]);
  return Number(row?.n ?? 0);
}

async function record(db: DB, key: string, nowMs: number): Promise<void> {
  await run(db, 'INSERT INTO auth_attempts (key, at) VALUES (?, ?)', [key, new Date(nowMs).toISOString()]);
  // 順手清掉一天前的紀錄，避免資料表一直變大
  await run(db, 'DELETE FROM auth_attempts WHERE at < ?', [since(86_400_000, nowMs)]);
}

const loginKey = (email: string) => `login:${email.trim().toLowerCase()}`;

/** 同一個帳號（email）10 分鐘內失敗 5 次即暫時鎖定 */
export async function isLoginLocked(db: DB, email: string, nowMs = Date.now()): Promise<boolean> {
  return (await count(db, loginKey(email), LOGIN_WINDOW_MS, nowMs)) >= LOGIN_MAX_FAILURES;
}

export async function recordLoginFailure(db: DB, email: string, nowMs = Date.now()): Promise<void> {
  await record(db, loginKey(email), nowMs);
}

export async function clearLoginFailures(db: DB, email: string): Promise<void> {
  await run(db, 'DELETE FROM auth_attempts WHERE key = ?', [loginKey(email)]);
}

/** 同一個 IP 一小時最多註冊 5 次；未超過時記一次並回傳 false */
export async function signupRateLimited(db: DB, ip: string, nowMs = Date.now()): Promise<boolean> {
  const key = `signup:${ip}`;
  if ((await count(db, key, SIGNUP_WINDOW_MS, nowMs)) >= SIGNUP_MAX) return true;
  await record(db, key, nowMs);
  return false;
}
