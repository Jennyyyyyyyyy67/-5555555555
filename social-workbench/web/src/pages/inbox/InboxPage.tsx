import { useEffect, useRef, useState } from 'react';
import { useBrandScope } from '../../brand/BrandScope';
import { api, errorMessage } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { useMeta } from '../../lib/meta';
import { formatDateTime, formatNumber, formatShortDateTime } from '../../lib/format';
import { useToast } from '../../components/Toast';
import {
  Badge,
  Button,
  EmptyState,
  ErrorMessage,
  Loading,
  PageHeader,
  PRIORITY_TONE,
  Select,
  STATUS_TONE,
  TextInput,
} from '../../components/ui';
import { BrandTag, IconClock, PlatformIcon } from '../../components/icons';
import {
  COMMENT_STATUSES,
  CONTENT_TYPE_LABELS,
  PRIORITY_LABELS,
  SLA_ACTIVE_STATUSES,
  STATUS_LABELS,
  type CommentStatus,
} from '../../../../shared/constants';
import type { CommentPreview, Paginated } from '../../../../shared/types';
import './inbox.css';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;


function Stars({ rating }: { rating: number }) {
  const r = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span className="ib-stars" title={`${r} 星評價`}>
      <span aria-hidden>{'★'.repeat(r) + '☆'.repeat(5 - r)}</span>
      <span className="sr-only">{r} 星評價</span>
    </span>
  );
}

function CommentRow({ c }: { c: CommentPreview }) {
  const isAd = c.isAd || c.contentType === 'ad';
  const showSla = c.slaDueAt !== null && c.firstResponseAt === null && SLA_ACTIVE_STATUSES.includes(c.status);
  return (
    <li className="inbox-row">
      <div className="ib-meta">
        <time className="ib-time" dateTime={c.occurredAt} title={formatDateTime(c.occurredAt)}>
          {formatShortDateTime(c.occurredAt)}
        </time>
        <BrandTag name={c.brandName} color={c.brandColor} />
      </div>

      <div className="ib-source">
        <span className="ib-account">
          <PlatformIcon platform={c.platform} size={18} />
          <span className="truncate">{c.accountName}</span>
        </span>
        <span className="ib-post">
          <span className="truncate muted" title={c.postTitle}>
            {c.postTitle || '（無標題）'}
          </span>
          {c.contentType !== 'ad' && <Badge>{CONTENT_TYPE_LABELS[c.contentType] ?? c.contentType}</Badge>}
          {isAd && <Badge tone="orange">廣告</Badge>}
        </span>
      </div>

      <div className="ib-comment">
        <div className="ib-author">
          <strong className="truncate">{c.authorName}</strong>
          {c.rating !== null && <Stars rating={c.rating} />}
        </div>
        <p className="ib-body" title={c.body}>
          {c.body}
        </p>
      </div>

      <div className="ib-cat">
        {c.categoryName ? <span className="ib-cat-name">{c.categoryName}</span> : <span className="muted">未分類</span>}
        {c.priority && (
          <Badge tone={PRIORITY_TONE[c.priority]} title={`優先順序：${PRIORITY_LABELS[c.priority]}`}>
            <span className="sr-only">優先順序</span>
            {PRIORITY_LABELS[c.priority]}
          </Badge>
        )}
      </div>

      <div className="ib-state">
        <div className="ib-status">
          <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABELS[c.status]}</Badge>
        </div>
        <div className="ib-assign">
          {c.assigneeName ? <span className="truncate">{c.assigneeName}</span> : <span className="muted">未指派</span>}
          {showSla && (
            <span className="ib-sla" title={`首次回覆時限：${formatDateTime(c.slaDueAt)}`}>
              <IconClock size={13} />
              時限 {formatShortDateTime(c.slaDueAt)}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export default function InboxPage() {
  const { brandParam } = useBrandScope();
  const { meta } = useMeta();
  const toast = useToast();
  const [platform, setPlatform] = useState('');
  const [status, setStatus] = useState<CommentStatus | ''>('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const filters = { brand: brandParam, platform, status, q };
  const filterKey = JSON.stringify(filters);
  const filterKeyRef = useRef(filterKey);
  filterKeyRef.current = filterKey;

  const { data, loading, error, reload, setData } = useQuery(
    () => api.get<Paginated<CommentPreview>>('/comments/preview', { ...filters, limit: PAGE_SIZE, offset: 0 }),
    [filterKey],
  );

  const loadMore = async () => {
    if (!data) return;
    const key = filterKey;
    setLoadingMore(true);
    try {
      const next = await api.get<Paginated<CommentPreview>>('/comments/preview', {
        ...filters,
        limit: PAGE_SIZE,
        offset: data.items.length,
      });
      if (filterKeyRef.current !== key) return; // 篩選條件已變更，丟棄過期的結果
      setData((prev) => {
        if (!prev) return next;
        const seen = new Set(prev.items.map((c) => c.id));
        return { ...prev, total: next.total, items: [...prev.items, ...next.items.filter((c) => !seen.has(c.id))] };
      });
    } catch (err) {
      toast.error(`載入更多留言失敗：${errorMessage(err)}`);
    } finally {
      setLoadingMore(false);
    }
  };

  const hasMore = !!data && data.items.length < data.total;

  return (
    <div className="inbox-page">
      <PageHeader
        title={
          <span className="inbox-title">
            收件匣
            <Badge tone="purple">階段 1 預覽</Badge>
          </span>
        }
        description="目前顯示模擬留言，可用來確認不同角色只看得到自己負責品牌的留言。完整收件匣（急迫排序、時效倒數、篩選與處理流程）將在階段 2 完成。"
      />

      <div className="toolbar inbox-toolbar">
        <Select aria-label="平台" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">全部平台</option>
          {(meta?.platforms ?? []).map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </Select>
        <Select aria-label="處理狀態" value={status} onChange={(e) => setStatus(e.target.value as CommentStatus | '')}>
          <option value="">全部狀態</option>
          {COMMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <TextInput
          type="search"
          className="inbox-search"
          aria-label="搜尋留言"
          placeholder="搜尋留言內容或留言者"
          value={search}
          maxLength={100}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="inbox-total muted" aria-live="polite">
          {data && !error ? `共 ${formatNumber(data.total)} 則` : ''}
        </span>
      </div>

      {error ? (
        <ErrorMessage error={error} onRetry={reload} />
      ) : !data ? (
        <Loading text="載入留言中…" />
      ) : data.items.length === 0 ? (
        <div className="card">
          <EmptyState title="這個條件下沒有留言" description="可以切換上方的品牌，或調整平台、狀態與搜尋條件。" />
        </div>
      ) : (
        <section className="card inbox-card" aria-busy={loading || undefined}>
          <div className={`inbox-list-wrap ${loading ? 'is-refreshing' : ''}`}>
            <div className="inbox-head" aria-hidden>
              <span>時間／品牌</span>
              <span>來源</span>
              <span>留言</span>
              <span>類型</span>
              <span>狀態／負責人</span>
            </div>
            <ul className="inbox-list">
              {data.items.map((c) => (
                <CommentRow key={c.id} c={c} />
              ))}
            </ul>
          </div>
          <div className="inbox-footer">
            <span className="muted small">
              已顯示 {formatNumber(data.items.length)}／{formatNumber(data.total)} 則
            </span>
            {hasMore && (
              <Button size="sm" onClick={() => void loadMore()} loading={loadingMore}>
                載入更多
              </Button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
