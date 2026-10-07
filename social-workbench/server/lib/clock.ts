// 統一的時間來源。測試時可用 setClock() 固定「現在」，方便驗證時效倒數等邏輯。
let nowFn: () => Date = () => new Date();

export function now(): Date {
  return nowFn();
}

export function nowIso(): string {
  return nowFn().toISOString();
}

export function setClock(fn: (() => Date) | null): void {
  nowFn = fn ?? (() => new Date());
}

export function addMinutes(iso: string | Date, minutes: number): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  return new Date(t + minutes * 60_000).toISOString();
}

export function minutesBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 60_000;
}
