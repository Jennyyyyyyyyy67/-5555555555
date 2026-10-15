import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useBrandScope } from '../../brand/BrandScope';
import { useMeta } from '../../lib/meta';
import { api } from '../../lib/api';
import { formatShortDateTime, formatDateTime } from '../../lib/format';
import { Avatar, Badge, Button, EmptyState, ErrorMessage, Loading, PRIORITY_TONE, STATUS_TONE, Select, TextInput } from '../../components/ui';
import { IconRefresh, IconSearch, IconShield, PlatformIcon } from '../../components/icons';
import { CONTENT_TYPE_LABELS, PRIORITY_LABELS, STATUS_LABELS, COMMENT_STATUSES, PRIORITIES } from '../../../../shared/constants';
import { INBOX_TABS, INBOX_TAB_LABELS, type InboxItem, type InboxResponse, type InboxTab } from '../../../../shared/types';
import { SlaChip, slaInfo, syncServerTime, useNow } from './sla';
import CommentDetailPane from './CommentDetail';
import './inbox.css';

const PAGE = 50;
const FILTER_KEYS = ['q', 'platform', 'accountId', 'category', 'priority', 'status', 'assignee', 'sla', 'adOnly', 'auto', 'postId'] as const;

export default function InboxPage() {
  const { id } = useParams();
  const selectedId = id ? Number(id) : null;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { brandParam } = useBrandScope();
  const { meta } = useMeta();
  const now = useNow(15_000);

  const tab = (params.get('tab') as InboxTab) || 'todo';
  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof FILTER_KEYS)[number], string>, [params]);
  const [qInput, setQInput] = useState(filters.q);
  const [showMore, setShowMore] = useState(() => !!(filters.status || filters.accountId || filters.adOnly || filters.auto || filters.postId));

  const [data, setData] = useState<InboxResponse | null>(null);
  const [extra, setExtra] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);

  const query = useMemo(() => ({ brand: brandParam, tab, ...filters, limit: PAGE }), [brandParam, tab, filters]);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      const s = ++seq.current;
      if (!opts.silent) setLoading(true);
      try {
        const res = await api.get<InboxResponse>('/comments', query);
        if (s !== seq.current) return;
        syncServerTime(res.serverTime);
        setData(res);
        setExtra([]);
        setError(null);
      } catch (err) {
        if (s === seq.current) setError(err);
      } finally {
        if (s === seq.current) setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    void load();
  }, [load]);
  // 每 30 秒自動更新（新留言、別人的處理狀態）
  useEffect(() => {
    const t = setInterval(() => void load({ silent: true }), 30_000);
    return () => clearInterval(t);
  }, [load]);
  // 已連結真實平台（Instagram）的帳號：收件匣開著時每 45 秒向平台抓一次新留言，抓完再更新列表
  useEffect(() => {
    let alive = true;
    let running = false;
    const sync = async () => {
      if (running) return;
      running = true;
      try {
        const r = await api.post<{ synced: number; newComments: number }>(`/integrations/auto-sync?brand=${encodeURIComponent(brandParam)}`);
        if (alive && r.newComments > 0) void load({ silent: true });
      } catch {
        /* 同步失敗不影響收件匣 */
      } finally {
        running = false;
      }
    };
    void sync();
    const t = setInterval(() => void sync(), 45_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [brandParam, load]);
  // 搜尋輸入防抖
  useEffect(() => {
    const t = setTimeout(() => {
      if (qInput !== filters.q) setFilter('q', qInput);
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const setTab = (t: InboxTab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  const clearFilters = () => {
    const next = new URLSearchParams();
    next.set('tab', tab);
    setParams(next, { replace: true });
    setQInput('');
  };
  const activeFilterCount = FILTER_KEYS.filter((k) => filters[k]).length;

  const loadMore = async () => {
    if (!data) return;
    const res = await api.get<InboxResponse>('/comments', { ...query, offset: data.items.length + extra.length });
    setExtra((e) => [...e, ...res.items]);
  };

  const items = data ? [...data.items, ...extra] : [];
  const open = (cid: number) => navigate({ pathname: `/inbox/${cid}`, search: params.toString() });
  const accounts = useMemo(() => {
    const m = new Map<number, { id: number; name: string; platform: string }>();
    for (const i of items) m.set(i.accountId, { id: i.accountId, name: i.accountName, platform: i.platform });
    return [...m.values()];
  }, [items]);

  return (
    <div className={`inbox ${selectedId ? 'has-detail' : ''}`}>
      <section className="inbox-list" aria-label="留言列表">
        <div className="inbox-head">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h1>收件匣</h1>
            <Button size="sm" variant="ghost" icon={<IconRefresh />} onClick={() => void load()} aria-label="重新整理">
              更新
            </Button>
          </div>
          {data && (data.overdue > 0 || data.nearDue > 0) && (
            <div className="inbox-alerts">
              {data.overdue > 0 && (
                <button className={`alert-pill overdue ${filters.sla === 'overdue' ? 'on' : ''}`} onClick={() => setFilter('sla', filters.sla === 'overdue' ? '' : 'overdue')}>
                  ⚠ 已超時 {data.overdue} 則
                </button>
              )}
              {data.nearDue > 0 && (
                <button className={`alert-pill near ${filters.sla === 'near' ? 'on' : ''}`} onClick={() => setFilter('sla', filters.sla === 'near' ? '' : 'near')}>
                  ⏱ 即將超時 {data.nearDue} 則
                </button>
              )}
            </div>
          )}
          <div className="inbox-tabs" role="tablist">
            {INBOX_TABS.map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`inbox-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                {INBOX_TAB_LABELS[t]}
                {data && t !== 'all' && t !== 'closed' && <span className="count">{data.tabCounts[t]}</span>}
              </button>
            ))}
          </div>
          <div className="inbox-filters">
            <div className="search">
              <IconSearch size={16} />
              <TextInput value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="搜尋留言內容或留言者" aria-label="搜尋" />
            </div>
            <Select value={filters.platform} onChange={(e) => setFilter('platform', e.target.value)} aria-label="平台">
              <option value="">全部平台</option>
              {meta?.platforms.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </Select>
            <Select value={filters.category} onChange={(e) => setFilter('category', e.target.value)} aria-label="留言類型">
              <option value="">全部類型</option>
              {meta?.categories
                .filter((c) => c.isActive)
                .map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name}
                  </option>
                ))}
            </Select>
            <Select value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)} aria-label="優先級">
              <option value="">全部優先級</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  優先級：{PRIORITY_LABELS[p]}
                </option>
              ))}
            </Select>
            <Select value={filters.assignee} onChange={(e) => setFilter('assignee', e.target.value)} aria-label="負責人">
              <option value="">全部負責人</option>
              <option value="me">我負責的</option>
              <option value="none">未指派</option>
            </Select>
            <Button size="sm" variant="ghost" onClick={() => setShowMore((v) => !v)} aria-expanded={showMore}>
              {showMore ? '收起篩選' : '更多篩選'}
            </Button>
            {activeFilterCount > 0 && (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                清除篩選（{activeFilterCount}）
              </Button>
            )}
          </div>
          {showMore && (
            <div className="inbox-filters more">
              <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} aria-label="狀態">
                <option value="">全部狀態</option>
                {COMMENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
              <Select value={filters.sla} onChange={(e) => setFilter('sla', e.target.value)} aria-label="時效">
                <option value="">全部時效</option>
                <option value="overdue">已超時</option>
                <option value="near">即將超時</option>
              </Select>
              <Select value={filters.accountId} onChange={(e) => setFilter('accountId', e.target.value)} aria-label="社群帳號">
                <option value="">全部帳號</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
              <Select value={filters.auto} onChange={(e) => setFilter('auto', e.target.value)} aria-label="AI 自動處理">
                <option value="">AI 自動處理：不限</option>
                <option value="1">只看 AI 自動處理</option>
                <option value="0">排除 AI 自動處理</option>
              </Select>
              <label className="checkbox">
                <input type="checkbox" checked={filters.adOnly === '1'} onChange={(e) => setFilter('adOnly', e.target.checked ? '1' : '')} />
                只看廣告留言
              </label>
              {filters.postId && (
                <Badge tone="blue">
                  只看單一貼文
                  <button className="link-btn" onClick={() => setFilter('postId', '')} aria-label="取消貼文篩選">
                    ✕
                  </button>
                </Badge>
              )}
            </div>
          )}
        </div>

        <div className="inbox-items">
          {error ? (
            <div style={{ padding: 16 }}>
              <ErrorMessage error={error} onRetry={() => void load()} />
            </div>
          ) : loading && !data ? (
            <Loading />
          ) : items.length === 0 ? (
            <EmptyState
              title={tab === 'todo' && activeFilterCount === 0 ? '目前沒有待處理的留言 🎉' : '這個條件下沒有留言'}
              description={activeFilterCount ? '試試清除篩選條件。' : undefined}
            />
          ) : (
            <ul>
              {items.map((c) => (
                <InboxRow key={c.id} c={c} now={now} selected={c.id === selectedId} onOpen={() => open(c.id)} />
              ))}
            </ul>
          )}
          {data && items.length < data.total && (
            <div className="load-more">
              <Button size="sm" onClick={() => void loadMore()}>
                載入更多（還有 {data.total - items.length} 則）
              </Button>
            </div>
          )}
        </div>
      </section>

      <section className="inbox-detail" aria-label="留言詳情">
        {selectedId ? (
          <CommentDetailPane
            key={selectedId}
            id={selectedId}
            onClose={() => navigate({ pathname: '/inbox', search: params.toString() })}
            onChanged={() => void load({ silent: true })}
            onFilterPost={(postId) => {
              const next = new URLSearchParams(params);
              next.set('postId', String(postId));
              next.set('tab', 'all');
              setShowMore(true);
              navigate({ pathname: '/inbox', search: next.toString() });
            }}
          />
        ) : (
          <EmptyState title="選擇一則留言開始處理" description="左側依急迫程度排序：已超時 → 即將超時 → 優先級高 → 剩餘時間少。" />
        )}
      </section>
    </div>
  );
}

function InboxRow({ c, now, selected, onOpen }: { c: InboxItem; now: number; selected: boolean; onOpen: () => void }) {
  const s = slaInfo(c, now);
  return (
    <li>
      <button className={`inbox-row urg-${s.state} ${selected ? 'selected' : ''}`} onClick={onOpen} aria-current={selected || undefined}>
        <div className="r-top">
          <span className="r-brand" title={c.brandName}>
            <span className="brand-dot" style={{ background: c.brandColor }} aria-hidden />
          </span>
          <PlatformIcon platform={c.platform} size={16} />
          <strong className="truncate">{c.authorName}</strong>
          {c.rating !== null && <span className="stars" aria-label={`${c.rating} 星`}>{'★'.repeat(c.rating)}</span>}
          <span className="muted small nowrap" title={formatDateTime(c.occurredAt)}>
            {formatShortDateTime(c.occurredAt)}
          </span>
          <span className="spacer" />
          <SlaChip c={c} now={now} size="sm" />
        </div>
        <p className="r-body">{c.visibility === 'deleted' ? <em className="muted">（留言已刪除）</em> : c.body}</p>
        <div className="r-meta">
          {c.categoryName && <Badge>{c.categoryName}</Badge>}
          {c.priority === 'high' && <Badge tone={PRIORITY_TONE.high}>優先級高</Badge>}
          {c.needsHuman && (
            <Badge tone="orange" title="涉及客訴、退款、敏感議題等，必須由人工處理">
              <IconShield size={12} /> 需人工
            </Badge>
          )}
          {c.isAd && <Badge tone="orange">廣告</Badge>}
          {c.isAutoHandled && <Badge tone="purple">AI 自動處理</Badge>}
          <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABELS[c.status]}</Badge>
          {c.visibility === 'hidden' && <Badge>已隱藏</Badge>}
          <span className="spacer" />
          {c.lockedByName ? (
            <span className="r-lock" title={`${c.lockedByName} 正在處理`}>
              🔒 {c.lockedByName} 處理中
            </span>
          ) : c.assigneeName ? (
            <span className="r-assignee" title={`負責人：${c.assigneeName}`}>
              <Avatar name={c.assigneeName} size="sm" />
            </span>
          ) : (
            <span className="muted small">未指派</span>
          )}
        </div>
        <div className="r-post muted small truncate">
          {CONTENT_TYPE_LABELS[c.contentType]}｜{c.postTitle}
          {c.threadCount > 0 && `・串內 ${c.threadCount + 1} 則`}
        </div>
      </button>
    </li>
  );
}

