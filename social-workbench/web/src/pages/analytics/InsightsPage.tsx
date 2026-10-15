// 社群洞察：把留言整理成行銷、產品與品牌經營可以用的資訊。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useBrandScope } from '../../brand/BrandScope';
import { api } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { Card, EmptyState, ErrorMessage, Loading, PageHeader } from '../../components/ui';
import type { InsightSection, InsightsResponse } from '../../../../shared/types';
import { RangePicker, useRange } from './common';
import './analytics.css';

export function InsightSectionCard({ s, compact }: { s: InsightSection; compact?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const items = compact ? s.items.slice(0, 3) : s.items;
  return (
    <Card title={s.title} className="an-insight">
      <p className="muted small" style={{ marginTop: 0 }}>
        {s.description}
      </p>
      {items.length === 0 ? (
        <p className="muted small">這段期間沒有相關留言。</p>
      ) : (
        <ol className="an-insight-list">
          {items.map((i) => (
            <li key={i.label}>
              <button type="button" className="an-insight-item" aria-expanded={open === i.label} onClick={() => setOpen(open === i.label ? null : i.label)}>
                <span>{i.label}</span>
                <span className="an-count">{i.count} 則</span>
              </button>
              {open === i.label && (
                <ul className="an-examples small">
                  {i.examples.map((x) => (
                    <li key={x.commentId}>
                      <Link to={`/inbox/${x.commentId}`}>
                        <strong>{x.authorName}</strong>：{x.body}
                      </Link>
                      <span className="muted">　{x.brandName}・{x.platform}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export default function InsightsPage() {
  const { brandParam } = useBrandScope();
  const rs = useRange('30d');
  const { from, to } = rs.range;
  const q = useQuery(() => api.get<InsightsResponse>('/analytics/insights', { brand: brandParam, from, to }), [brandParam, from, to]);
  return (
    <>
      <PageHeader
        title="社群洞察"
        description="AI 把留言整理成熱門問題、常見抱怨、購買阻力、潛在商機與內容建議，讓留言不只是回完就結束，而能成為行銷、產品與品牌經營的參考。點每一項可以看到原始留言。"
        actions={<RangePicker state={rs} />}
      />
      {q.loading && !q.data ? (
        <Loading />
      ) : q.error ? (
        <ErrorMessage error={q.error} onRetry={() => void q.reload()} />
      ) : q.data && q.data.totalComments === 0 ? (
        <Card>
          <EmptyState title="這段期間沒有留言" description="換一個日期範圍試試看。" />
        </Card>
      ) : q.data ? (
        <>
          <p className="small muted">分析 {q.data.totalComments} 則留言。</p>
          <div className="an-grid an-grid-insights">
            {q.data.sections.map((s) => (
              <InsightSectionCard key={s.key} s={s} />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
