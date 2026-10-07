// 日期與數字格式（台灣慣用格式，顯示使用者電腦的時區）

const pad = (n: number) => String(n).padStart(2, '0');

/** 2026/10/07 14:05 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 今天的話只顯示 14:05，否則 10/06 14:05 */
export function formatShortDateTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sameDay = d.toDateString() === now.toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay) return time;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
}

/** 3 分鐘前、2 小時前、昨天、3 天前 */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = now - Date.parse(iso);
  if (Number.isNaN(diff)) return '—';
  const future = diff < 0;
  const abs = Math.abs(diff);
  const min = Math.floor(abs / 60_000);
  let text: string;
  if (min < 1) text = '不到 1 分鐘';
  else if (min < 60) text = `${min} 分鐘`;
  else if (min < 60 * 24) text = `${Math.floor(min / 60)} 小時`;
  else text = `${Math.floor(min / 60 / 24)} 天`;
  if (min < 1 && !future) return '剛剛';
  return future ? `${text}後` : `${text}前`;
}

/** 把分鐘數轉成「1 小時 5 分」 */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  const m = Math.round(Math.abs(minutes));
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小時 ${rest} 分` : `${h} 小時`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('zh-TW');
}

export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}
