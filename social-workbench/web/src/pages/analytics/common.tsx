// 數據頁共用元件：日期範圍、數字卡、橫條圖、每日堆疊長條圖。
// 圖表顏色：單一數量用一個色相；情緒用正面／中性／負面三色（已通過色盲辨識檢查），並一律附圖例、數值與表格。
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Select, TextInput } from '../../components/ui';
import { formatNumber } from '../../lib/format';
import type { CountItem, DailyPoint, DateRange } from '../../../../shared/types';

/** 台灣時間的今天 YYYY-MM-DD */
export function todayTw(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function shiftDate(date: string, days: number): string {
  const t = Date.parse(`${date}T12:00:00+08:00`) + days * 86_400_000;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}
const monthStart = (d: string) => `${d.slice(0, 8)}01`;
function monthEnd(d: string): string {
  const [y, m] = d.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${d.slice(0, 8)}${String(last).padStart(2, '0')}`;
}
/** 以週一為一週的開始 */
function weekStart(d: string): string {
  const day = new Date(`${d}T12:00:00+08:00`).getUTCDay();
  return shiftDate(d, -((day + 6) % 7));
}

export type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'custom';
export const PRESET_LABELS: Record<Preset, string> = {
  today: '今天',
  yesterday: '昨天',
  '7d': '最近 7 天',
  '30d': '最近 30 天',
  this_week: '本週',
  last_week: '上週',
  this_month: '本月',
  last_month: '上個月',
  custom: '自訂日期',
};

export function presetRange(p: Preset, custom: DateRange): DateRange {
  const t = todayTw();
  switch (p) {
    case 'today':
      return { from: t, to: t };
    case 'yesterday':
      return { from: shiftDate(t, -1), to: shiftDate(t, -1) };
    case '7d':
      return { from: shiftDate(t, -6), to: t };
    case '30d':
      return { from: shiftDate(t, -29), to: t };
    case 'this_week':
      return { from: weekStart(t), to: t };
    case 'last_week': {
      const s = shiftDate(weekStart(t), -7);
      return { from: s, to: shiftDate(s, 6) };
    }
    case 'this_month':
      return { from: monthStart(t), to: t };
    case 'last_month': {
      const prev = shiftDate(monthStart(t), -1);
      return { from: monthStart(prev), to: monthEnd(prev) };
    }
    default:
      return custom;
  }
}

export function useRange(initial: Preset = '7d') {
  const [preset, setPreset] = useState<Preset>(initial);
  const [custom, setCustom] = useState<DateRange>(() => presetRange('7d', { from: todayTw(), to: todayTw() }));
  const range = presetRange(preset, custom);
  return { preset, setPreset, custom, setCustom, range };
}

export function RangePicker({ state, presets }: { state: ReturnType<typeof useRange>; presets?: Preset[] }) {
  const list = presets ?? (['today', '7d', '30d', 'this_month', 'last_month', 'custom'] as Preset[]);
  return (
    <div className="an-range">
      <Select value={state.preset} onChange={(e) => state.setPreset(e.target.value as Preset)} aria-label="日期範圍" style={{ width: 'auto' }}>
        {list.map((p) => (
          <option key={p} value={p}>
            {PRESET_LABELS[p]}
          </option>
        ))}
      </Select>
      {state.preset === 'custom' ? (
        <span className="an-range-custom">
          <TextInput type="date" value={state.custom.from} max={state.custom.to} onChange={(e) => e.target.value && state.setCustom({ ...state.custom, from: e.target.value })} aria-label="開始日期" />
          <span className="muted">～</span>
          <TextInput type="date" value={state.custom.to} min={state.custom.from} onChange={(e) => e.target.value && state.setCustom({ ...state.custom, to: e.target.value })} aria-label="結束日期" />
        </span>
      ) : (
        <span className="muted small">
          {state.range.from === state.range.to ? state.range.from : `${state.range.from} ～ ${state.range.to}`}
        </span>
      )}
    </div>
  );
}

export function StatTile({ label, value, sub, tone, to }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'danger' | 'warning' | 'good'; to?: string }) {
  const body = (
    <>
      <span className="an-stat-label">{label}</span>
      <span className={`an-stat-value ${tone ? `tone-${tone}` : ''}`}>
        {tone === 'danger' ? '⚠ ' : tone === 'warning' ? '⏱ ' : ''}
        {value}
      </span>
      {sub && <span className="an-stat-sub">{sub}</span>}
    </>
  );
  return to ? (
    <Link to={to} className="an-stat an-stat-link">
      {body}
    </Link>
  ) : (
    <div className="an-stat">{body}</div>
  );
}

/** 單一數量的橫條圖（一個色相），數值直接標在右側 */
export function HBarList({ items, empty = '沒有資料', suffix, extra }: { items: Array<CountItem & { color?: string }>; empty?: string; suffix?: (i: CountItem) => ReactNode; extra?: (i: CountItem) => ReactNode }) {
  if (items.length === 0) return <p className="muted small">{empty}</p>;
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <ul className="an-hbars">
      {items.map((i) => (
        <li key={i.key} title={`${i.label}：${formatNumber(i.count)} 則`}>
          <span className="an-hbar-label">
            {i.color && <span className="an-dot" style={{ background: i.color }} aria-hidden />}
            {i.label}
          </span>
          <span className="an-hbar-track">
            <span className="an-hbar-fill" style={{ width: `${Math.max(2, (i.count / max) * 100)}%` }} />
          </span>
          <span className="an-hbar-value">
            {formatNumber(i.count)}
            {suffix?.(i)}
          </span>
          {extra && <span className="an-hbar-extra">{extra(i)}</span>}
        </li>
      ))}
    </ul>
  );
}

const SENTIMENT_SERIES = [
  { key: 'positive', label: '正面', color: 'var(--viz-positive)' },
  { key: 'neutral', label: '中性', color: 'var(--viz-neutral)' },
  { key: 'negative', label: '負面', color: 'var(--viz-negative)' },
] as const;

/** 每日留言量（依情緒堆疊），滑過顯示當天明細，可切換成表格 */
export function DailyChart({ daily }: { daily: DailyPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(...daily.map((d) => d.total), 1);
  const step = Math.max(1, Math.ceil(daily.length / 10));
  const h = hover !== null ? daily[hover] : null;
  return (
    <div className="an-daily">
      <div className="an-legend">
        {SENTIMENT_SERIES.map((s) => (
          <span key={s.key}>
            <span className="an-swatch" style={{ background: s.color }} aria-hidden />
            {s.label}
          </span>
        ))}
        <button type="button" className="an-link-btn" onClick={() => setTable((v) => !v)}>
          {table ? '顯示圖表' : '顯示表格'}
        </button>
      </div>
      {table ? (
        <div className="table-wrap">
          <table className="table an-table">
            <thead>
              <tr>
                <th>日期</th>
                <th className="num">留言</th>
                <th className="num">正面</th>
                <th className="num">中性</th>
                <th className="num">負面</th>
                <th className="num">首次回覆</th>
                <th className="num">AI 自動回覆</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td className="num">{d.total}</td>
                  <td className="num">{d.positive}</td>
                  <td className="num">{d.neutral}</td>
                  <td className="num">{d.negative}</td>
                  <td className="num">{d.firstResponses}</td>
                  <td className="num">{d.autoReplied}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="an-daily-plot" onMouseLeave={() => setHover(null)}>
          <div className="an-daily-y" aria-hidden>
            <span>{max}</span>
            <span>0</span>
          </div>
          <div className="an-daily-bars" role="img" aria-label={`每日留言量：${daily.map((d) => `${d.date} ${d.total} 則`).join('、')}`}>
            {daily.map((d, i) => (
              <div key={d.date} className={`an-daily-col ${hover === i ? 'active' : ''}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}>
                <div className="an-daily-stack" style={{ height: `${(d.total / max) * 100}%` }}>
                  {SENTIMENT_SERIES.map((s) =>
                    d[s.key] > 0 ? <span key={s.key} style={{ flexGrow: d[s.key], background: s.color }} /> : null,
                  ).reverse()}
                </div>
                <span className="an-daily-x">{i % step === 0 || i === daily.length - 1 ? d.date.slice(5).replace('-', '/') : ''}</span>
              </div>
            ))}
          </div>
          {h && (
            <div className="an-tooltip" style={{ left: `${((hover! + 0.5) / daily.length) * 100}%` }}>
              <strong>{h.date}</strong>
              <span>留言 {h.total} 則</span>
              {SENTIMENT_SERIES.map((s) => (
                <span key={s.key}>
                  <span className="an-swatch" style={{ background: s.color }} aria-hidden />
                  {s.label} {h[s.key]}
                </span>
              ))}
              <span className="muted">首次回覆 {h.firstResponses}・AI 自動 {h.autoReplied}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 正面／中性／負面比例條 */
export function SentimentBar({ s }: { s: { positive: number; neutral: number; negative: number } }) {
  const total = s.positive + s.neutral + s.negative;
  if (!total) return <p className="muted small">沒有資料</p>;
  return (
    <div>
      <div className="an-sentiment" role="img" aria-label={`正面 ${s.positive}、中性 ${s.neutral}、負面 ${s.negative}`}>
        {SENTIMENT_SERIES.map((x) => (s[x.key] > 0 ? <span key={x.key} style={{ flexGrow: s[x.key], background: x.color }} title={`${x.label} ${s[x.key]} 則`} /> : null))}
      </div>
      <div className="an-legend">
        {SENTIMENT_SERIES.map((x) => (
          <span key={x.key}>
            <span className="an-swatch" style={{ background: x.color }} aria-hidden />
            {x.label} {s[x.key]}（{Math.round((s[x.key] / total) * 100)}%）
          </span>
        ))}
      </div>
    </div>
  );
}

/** 與前一期的變化 */
export function Delta({ cur, prev, better = 'up', percent }: { cur: number | null; prev: number | null; better?: 'up' | 'down'; percent?: boolean }) {
  if (cur === null || prev === null) return null;
  const d = percent ? Math.round((cur - prev) * 100) : prev ? Math.round(((cur - prev) / prev) * 100) : null;
  if (d === null || d === 0) return <span className="an-delta">持平</span>;
  const good = (d > 0) === (better === 'up');
  return (
    <span className={`an-delta ${good ? 'good' : 'bad'}`}>
      {d > 0 ? '▲' : '▼'} {Math.abs(d)}
      {percent ? ' 個百分點' : '%'}
    </span>
  );
}
