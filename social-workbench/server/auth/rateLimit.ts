// 簡易登入失敗限制：同一個帳號（email）10 分鐘內失敗 5 次即暫時鎖定。
const WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 5;
const failures = new Map<string, number[]>();

function recent(key: string, nowMs: number): number[] {
  const list = (failures.get(key) ?? []).filter((t) => nowMs - t < WINDOW_MS);
  failures.set(key, list);
  return list;
}

export function isLoginLocked(email: string, nowMs = Date.now()): boolean {
  return recent(email.toLowerCase(), nowMs).length >= MAX_FAILURES;
}

export function recordLoginFailure(email: string, nowMs = Date.now()): void {
  const key = email.toLowerCase();
  recent(key, nowMs).push(nowMs);
}

export function clearLoginFailures(email: string): void {
  failures.delete(email.toLowerCase());
}

export function resetAllLoginFailures(): void {
  failures.clear();
}
