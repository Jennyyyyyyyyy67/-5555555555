// 回覆時效：倒數、即將超時、已超時的判斷與顯示
import { useEffect, useState } from 'react';
import type { InboxItem } from '../../../../shared/types';
import { SLA_ACTIVE_STATUSES } from '../../../../shared/constants';

let serverOffsetMs = 0;
/** 用伺服器時間校正本機時鐘（避免電腦時間不準造成倒數錯誤） */
export function syncServerTime(serverTime: string): void {
  const t = Date.parse(serverTime);
  if (!Number.isNaN(t)) serverOffsetMs = t - Date.now();
}
export const serverNow = () => Date.now() + serverOffsetMs;

/** 每隔一段時間重新渲染，讓倒數更新 */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export type SlaState = 'overdue' | 'near' | 'ok' | 'met' | 'late' | 'none';

export interface SlaInfo {
  state: SlaState;
  /** 剩餘分鐘（負數代表已超時幾分鐘） */
  minutes: number | null;
  label: string;
}

type SlaFields = Pick<InboxItem, 'status' | 'slaDueAt' | 'firstResponseAt' | 'nearDueMinutes'>;

export function slaInfo(c: SlaFields, now: number): SlaInfo {
  if (!c.slaDueAt) return { state: 'none', minutes: null, label: '不計時' };
  const due = Date.parse(c.slaDueAt);
  if (c.firstResponseAt) {
    const ok = Date.parse(c.firstResponseAt) <= due;
    return { state: ok ? 'met' : 'late', minutes: null, label: ok ? '時效內已回覆' : '逾時才回覆' };
  }
  if (!SLA_ACTIVE_STATUSES.includes(c.status)) return { state: 'none', minutes: null, label: '不計時' };
  const minutes = Math.floor((due - now) / 60_000);
  if (minutes < 0) return { state: 'overdue', minutes, label: `超時 ${fmt(-minutes)}` };
  if (minutes < c.nearDueMinutes) return { state: 'near', minutes, label: `剩 ${fmt(minutes)}` };
  return { state: 'ok', minutes, label: `剩 ${fmt(minutes)}` };
}

function fmt(m: number): string {
  if (m < 1) return '不到 1 分';
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天`;
}

export function SlaChip({ c, now, size = 'md' }: { c: SlaFields; now: number; size?: 'sm' | 'md' }) {
  const s = slaInfo(c, now);
  if (s.state === 'none') return null;
  return (
    <span className={`sla-chip sla-${s.state} ${size === 'sm' ? 'sla-sm' : ''}`} title={c.slaDueAt ? `首次回覆時限：${new Date(c.slaDueAt).toLocaleString('zh-TW')}` : undefined}>
      {s.state === 'overdue' ? '⚠ ' : s.state === 'near' ? '⏱ ' : ''}
      {s.label}
    </span>
  );
}
