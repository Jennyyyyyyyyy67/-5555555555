// 報表：每日摘要、每週、每月或自訂日期範圍；含與前一期比較、品牌與平台比較、AI 成效、回覆效率、熱門問題、異常事件與洞察。
// 可直接列印或存成 PDF，比較表可下載 CSV。
import { useBrandScope } from '../../brand/BrandScope';
import { api } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { formatDateTime, formatMinutes, formatNumber, formatPercent } from '../../lib/format';
import { Badge, Button, Card, ErrorMessage, Loading, PageHeader } from '../../components/ui';
import type { ComparisonRow, ReportResponse } from '../../../../shared/types';
import { DailyChart, Delta, HBarList, RangePicker, SentimentBar, useRange, type Preset } from './common';
import { InsightSectionCard } from './InsightsPage';
import './analytics.css';

const REPORT_PRESETS: Preset[] = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', '7d', '30d', 'custom'];

function downloadCsv(name: string, rows: ComparisonRow[]) {
  const head = ['名稱', '留言數', '負面', '客訴', '平均首次回覆（分）', '時效達成率', 'AI 自動回覆比例', 'AI 建議採用率'];
  const pct = (x: number | null) => (x === null ? '' : `${Math.round(x * 100)}%`);
  const lines = [head, ...rows.map((r) => [r.label, r.total, r.negative, r.complaints, r.avgFirstResponseMinutes === null ? '' : Math.round(r.avgFirstResponseMinutes), pct(r.slaMetRate), pct(r.autoRate), pct(r.adoptionRate)])];
  const csv = '﻿' + lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function ComparisonTable({ title, rows, file }: { title: string; rows: ComparisonRow[]; file: string }) {
  return (
    <Card
      title={title}
      actions={
        rows.length > 0 ? (
          <Button size="sm" variant="ghost" className="no-print" onClick={() => downloadCsv(file, rows)}>
            下載 CSV
          </Button>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <p className="muted small">沒有資料</p>
      ) : (
        <div className="table-wrap">
          <table className="table an-table">
            <thead>
              <tr>
                <th>名稱</th>
                <th className="num">留言</th>
                <th className="num">負面</th>
                <th className="num">客訴</th>
                <th className="num">平均首回</th>
                <th className="num">時效達成</th>
                <th className="num">AI 自動回覆</th>
                <th className="num">AI 採用率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className="num">{r.total}</td>
                  <td className="num">{r.negative}</td>
                  <td className="num">{r.complaints}</td>
                  <td className="num">{formatMinutes(r.avgFirstResponseMinutes)}</td>
                  <td className="num">{formatPercent(r.slaMetRate)}</td>
                  <td className="num">{formatPercent(r.autoRate)}</td>
                  <td className="num">{formatPercent(r.adoptionRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Metric({ label, value, delta }: { label: string; value: string; delta?: React.ReactNode }) {
  return (
    <div className="an-metric">
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
      {delta}
    </div>
  );
}

export default function ReportsPage() {
  const { brandParam, currentBrand } = useBrandScope();
  const rs = useRange('this_week');
  const { from, to } = rs.range;
  const q = useQuery(() => api.get<ReportResponse>('/analytics/report', { brand: brandParam, from, to }), [brandParam, from, to]);
  const r = q.data;
  const title = rs.preset === 'today' || rs.preset === 'yesterday' ? '每日社群摘要' : rs.preset.includes('week') ? '每週社群報告' : rs.preset.includes('month') ? '每月社群報告' : '社群報告';

  return (
    <>
      <PageHeader
        title="報表"
        description="選擇日期範圍產生社群報告，會與前一段等長期間比較。可以直接列印或存成 PDF 分享給主管。"
        actions={
          <div className="row-wrap no-print">
            <RangePicker state={rs} presets={REPORT_PRESETS} />
            <Button variant="primary" disabled={!r} onClick={() => window.print()}>
              列印／存成 PDF
            </Button>
          </div>
        }
      />
      {q.loading && !r ? (
        <Loading />
      ) : q.error ? (
        <ErrorMessage error={q.error} onRetry={() => void q.reload()} />
      ) : r ? (
        <div className="stack an-report">
          <div className="an-report-head">
            <h2>
              {currentBrand ? `${currentBrand.name}・` : ''}
              {title}
            </h2>
            <span className="muted small">
              {r.range.from === r.range.to ? r.range.from : `${r.range.from} ～ ${r.range.to}`}（比較期間 {r.previous.from} ～ {r.previous.to}）・產生於 {formatDateTime(r.generatedAt)}
            </span>
          </div>

          <Card title="重點摘要">
            <ul className="an-highlights">
              {r.highlights.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </Card>

          <div className="an-grid">
            <Card title="回覆效率">
              <div className="an-metrics">
                <Metric label="留言數" value={formatNumber(r.ops.total)} delta={<Delta cur={r.ops.total} prev={r.previousOps.total} better="up" />} />
                <Metric label="60 分鐘內首次回覆" value={formatPercent(r.ops.within60Rate)} delta={<Delta cur={r.ops.within60Rate} prev={r.previousOps.within60Rate} percent />} />
                <Metric label="時效達成率" value={formatPercent(r.ops.slaMetRate)} delta={<Delta cur={r.ops.slaMetRate} prev={r.previousOps.slaMetRate} percent />} />
                <Metric label="平均首次回覆" value={formatMinutes(r.ops.avgFirstResponseMinutes)} delta={<Delta cur={r.ops.avgFirstResponseMinutes} prev={r.previousOps.avgFirstResponseMinutes} better="down" />} />
              </div>
            </Card>
            <Card title="AI 處理成效">
              <div className="an-metrics">
                <Metric label="AI 自動回覆" value={formatNumber(r.ai.autoReplied)} delta={<Delta cur={r.ai.autoReplied} prev={r.previousAi.autoReplied} />} />
                <Metric label="AI 建議採用率" value={formatPercent(r.ai.adoptionRate)} delta={<Delta cur={r.ai.adoptionRate} prev={r.previousAi.adoptionRate} percent />} />
                <Metric label="採用後修改比例" value={formatPercent(r.ai.editRate)} />
                <Metric label="知識不足" value={formatNumber(r.ai.knowledgeGap)} delta={<Delta cur={r.ai.knowledgeGap} prev={r.previousAi.knowledgeGap} better="down" />} />
              </div>
            </Card>
          </div>

          <Card title="每日留言量與情緒">
            <DailyChart daily={r.daily} />
          </Card>

          <div className="an-grid">
            <Card title="情緒分布">
              <SentimentBar s={r.community.sentiment} />
              <div className="an-status-row small" style={{ marginTop: 12 }}>
                <span>客訴 <strong>{r.community.complaints}</strong></span>
                <span>潛在商機 <strong>{r.community.opportunities}</strong></span>
              </div>
            </Card>
            <Card title="熱門問題">
              <HBarList items={r.community.commonQuestions} empty="沒有常見問題" />
            </Card>
          </div>

          <ComparisonTable title="品牌比較" rows={r.brands} file={`品牌比較_${r.range.from}_${r.range.to}.csv`} />
          <ComparisonTable title="平台比較" rows={r.platforms} file={`平台比較_${r.range.from}_${r.range.to}.csv`} />

          <Card title={`重要異常事件（${r.anomalies.length}）`}>
            {r.anomalies.length === 0 ? (
              <p className="muted small">這段期間沒有偵測到異常事件。</p>
            ) : (
              <ul className="an-report-events">
                {r.anomalies.map((e) => (
                  <li key={e.key}>
                    <Badge tone={e.severity === 'high' ? 'red' : e.severity === 'medium' ? 'orange' : 'gray'}>{e.severity === 'high' ? '重要' : e.severity === 'medium' ? '注意' : '參考'}</Badge>
                    <span>
                      <strong>{e.title}</strong>
                      <span className="muted small">　{e.typeLabel}・{e.brandName}{e.ack ? `・已處理（${e.ack.userName}${e.ack.note ? `：${e.ack.note}` : ''}）` : ''}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <h2 className="an-section-title">社群洞察</h2>
          <div className="an-grid an-grid-insights">
            {r.insights
              .filter((s) => s.items.length > 0)
              .map((s) => (
                <InsightSectionCard key={s.key} s={s} compact />
              ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
