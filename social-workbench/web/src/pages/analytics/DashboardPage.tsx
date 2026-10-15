// 數據看板：營運、AI 使用、社群分析、團隊處理數據。品牌依右上角品牌選擇，日期可選範圍。
import { Link } from 'react-router-dom';
import { useBrandScope } from '../../brand/BrandScope';
import { api } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { formatMinutes, formatNumber, formatPercent } from '../../lib/format';
import { Alert, Badge, Card, ErrorMessage, Loading, PageHeader } from '../../components/ui';
import { PlatformIcon } from '../../components/icons';
import { ROLE_LABELS } from '../../../../shared/constants';
import type { AnomaliesResponse, DashboardResponse, PostVolume } from '../../../../shared/types';
import { DailyChart, HBarList, RangePicker, SentimentBar, StatTile, useRange } from './common';
import './analytics.css';

function PostList({ posts, empty }: { posts: PostVolume[]; empty: string }) {
  if (posts.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <ol className="an-posts">
      {posts.map((p) => (
        <li key={p.postId}>
          <PlatformIcon platform={p.platform} size={16} />
          <Link to={`/inbox?tab=all&postId=${p.postId}`} className="an-ellipsis">
            {p.title}
          </Link>
          <span className="muted small">{p.brandName}</span>
          <strong>{p.count}</strong>
          {p.negative > 0 && <Badge tone="orange">負面 {p.negative}</Badge>}
        </li>
      ))}
    </ol>
  );
}

export default function DashboardPage() {
  const { brandParam } = useBrandScope();
  const rs = useRange('7d');
  const { from, to } = rs.range;
  const q = useQuery(() => api.get<DashboardResponse>('/analytics/dashboard', { brand: brandParam, from, to }), [brandParam, from, to]);
  const an = useQuery(() => api.get<AnomaliesResponse>('/analytics/anomalies', { brand: brandParam }), [brandParam]);
  const d = q.data;
  const openEvents = (an.data?.events ?? []).filter((e) => !e.ack);

  return (
    <>
      <PageHeader title="數據看板" description="掌握留言量、回覆時效、AI 使用成效與團隊處理狀況。即將超時、已超時為目前即時數字；其他數字依選擇的日期範圍計算。" actions={<RangePicker state={rs} />} />
      {q.loading && !d ? (
        <Loading />
      ) : q.error ? (
        <ErrorMessage error={q.error} onRetry={() => void q.reload()} />
      ) : d ? (
        <div className="stack an-page">
          {openEvents.length > 0 && (
            <Alert tone={openEvents.some((e) => e.severity === 'high') ? 'danger' : 'warning'}>
              <strong>有 {openEvents.length} 件值得注意的事件：</strong>
              {openEvents
                .slice(0, 3)
                .map((e) => e.title)
                .join('；')}
              {openEvents.length > 3 ? '…' : ''}
              <Link to="/anomalies"> 查看異常事件 →</Link>
            </Alert>
          )}

          <section aria-labelledby="ops-h">
            <h2 id="ops-h" className="an-section-title">基本營運</h2>
            <div className="an-stats">
              <StatTile label="總留言數" value={formatNumber(d.ops.total)} sub={`今日 ${formatNumber(d.ops.today)} 則`} />
              <StatTile label="60 分鐘內首次回覆" value={formatPercent(d.ops.within60Rate)} sub={`需回覆 ${d.ops.needReply} 則`} tone={d.ops.within60Rate !== null && d.ops.within60Rate < 0.8 ? 'warning' : undefined} />
              <StatTile label="時效達成率" value={formatPercent(d.ops.slaMetRate)} sub="依各留言類型的時限" />
              <StatTile label="平均首次回覆" value={formatMinutes(d.ops.avgFirstResponseMinutes)} />
              <StatTile label="即將超時（目前）" value={d.ops.nearDue} tone={d.ops.nearDue ? 'warning' : undefined} to="/inbox?tab=todo&sla=near" />
              <StatTile label="已超時（目前）" value={d.ops.overdue} tone={d.ops.overdue ? 'danger' : undefined} to="/inbox?tab=todo&sla=overdue" />
            </div>
            <div className="an-status-row small">
              <span>待處理 <strong>{d.ops.pending}</strong></span>
              <span>處理中 <strong>{d.ops.inProgress}</strong></span>
              <span>等待對方 <strong>{d.ops.waiting}</strong></span>
              <span>已轉交 <strong>{d.ops.transferred}</strong></span>
              <span>已完成 <strong>{d.ops.done}</strong></span>
              <span>無需處理 <strong>{d.ops.noAction}</strong></span>
              <span className="muted">（範圍內留言目前的狀態）</span>
            </div>
          </section>

          <Card title="每日留言量與情緒">
            <DailyChart daily={d.daily} />
          </Card>

          <section aria-labelledby="ai-h">
            <h2 id="ai-h" className="an-section-title">AI 使用</h2>
            <div className="an-stats">
              <StatTile label="AI 建議次數" value={formatNumber(d.ai.suggestions)} />
              <StatTile label="AI 建議採用率" value={formatPercent(d.ai.adoptionRate)} sub={`人工回覆 ${d.ai.humanReplies} 則`} />
              <StatTile label="採用後修改比例" value={formatPercent(d.ai.editRate)} />
              <StatTile label="AI 自動回覆" value={formatNumber(d.ai.autoReplied)} sub={`佔留言 ${formatPercent(d.ai.autoRate)}`} />
              <StatTile label="AI 轉人工" value={formatNumber(d.ai.forcedHuman)} sub="客訴、風險、規則等" />
              <StatTile label="知識不足" value={formatNumber(d.ai.knowledgeGap)} sub={d.ai.knowledgeGap ? <Link to="/knowledge">補充知識庫 →</Link> : undefined} />
            </div>
          </section>

          <section aria-labelledby="community-h">
            <h2 id="community-h" className="an-section-title">社群分析</h2>
            <div className="an-grid">
              <Card title="各平台留言量">
                <HBarList items={d.community.byPlatform} extra={(i) => { const n = d.community.byPlatform.find((x) => x.key === i.key)!.negative; return n ? `負面 ${n}` : ''; }} />
              </Card>
              <Card title="各品牌留言量">
                <HBarList items={d.community.byBrand} extra={(i) => { const n = d.community.byBrand.find((x) => x.key === i.key)!.negative; return n ? `負面 ${n}` : ''; }} />
              </Card>
              <Card title="正面／中性／負面">
                <SentimentBar s={d.community.sentiment} />
                <div className="an-status-row small" style={{ marginTop: 12 }}>
                  <span>客訴 <strong>{d.community.complaints}</strong></span>
                  <span>潛在商機 <strong>{d.community.opportunities}</strong></span>
                </div>
              </Card>
              <Card title="留言類型分布">
                <HBarList items={d.community.byCategory.slice(0, 8)} />
              </Card>
              <Card title="留言最多的貼文">
                <PostList posts={d.community.topPosts} empty="沒有貼文留言" />
              </Card>
              <Card title="留言最多的廣告">
                <PostList posts={d.community.topAds} empty="這段期間沒有廣告留言" />
              </Card>
              <Card title="熱門話題">
                <HBarList items={d.community.hotTopics.slice(0, 8)} />
              </Card>
              <Card title="常見問題" actions={<Link className="small" to="/insights">更多洞察 →</Link>}>
                <HBarList items={d.community.commonQuestions} empty="沒有常見問題" />
              </Card>
            </div>
          </section>

          <Card title="團隊處理數據">
            <p className="muted small" style={{ marginTop: 0 }}>
              處理數量只是參考之一；請一併看回覆速度、超時比例與處理的留言類型（例如客訴比一般互動花時間），不要只用數量評估績效。
            </p>
            {d.team.length === 0 ? (
              <p className="muted small">這段期間沒有人工處理紀錄。</p>
            ) : (
              <div className="table-wrap">
                <table className="table an-table">
                  <thead>
                    <tr>
                      <th>人員</th>
                      <th className="num">處理留言</th>
                      <th className="num">回覆</th>
                      <th className="num">首次回覆</th>
                      <th className="num">平均首回時間</th>
                      <th className="num">超時比例</th>
                      <th className="num">AI 建議使用</th>
                      <th>主要處理類型</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.team.map((t) => (
                      <tr key={t.userId}>
                        <td>
                          {t.name} <span className="muted small">{ROLE_LABELS[t.role]}</span>
                        </td>
                        <td className="num">{t.handled}</td>
                        <td className="num">{t.replies}</td>
                        <td className="num">{t.firstResponses}</td>
                        <td className="num">{formatMinutes(t.avgFirstResponseMinutes)}</td>
                        <td className="num">{t.lateRate !== null && t.lateRate > 0.2 ? <strong className="an-bad">{formatPercent(t.lateRate)}</strong> : formatPercent(t.lateRate)}</td>
                        <td className="num">{formatPercent(t.aiUseRate)}</td>
                        <td className="small">{t.topCategories.map((c) => `${c.label} ${c.count}`).join('、') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}
    </>
  );
}
