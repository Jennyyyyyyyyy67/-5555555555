// 相似留言：同一篇內容底下問同一件事的留言自動分組，可批次查看、選取、產生 AI 回覆、確認送出或標記。
// 每一則留言仍各自留下 AI 建議、回覆與操作紀錄；客訴、退款、敏感等留言不會被分組，必須個別處理。
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useBrandScope } from '../../brand/BrandScope';
import { useMeta } from '../../lib/meta';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { formatShortDateTime } from '../../lib/format';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, ErrorMessage, Loading, PageHeader, Select, Textarea } from '../../components/ui';
import { BrandTag, IconRefresh, PlatformIcon } from '../../components/icons';
import { SlaChip, syncServerTime, useNow } from '../inbox/sla';
import { CONTENT_TYPE_LABELS, DEFAULT_NEAR_DUE_MINUTES, STATUS_LABELS } from '../../../../shared/constants';
import type { BatchResult, BatchSuggestResponse, CommentGroup, CommentGroupsResponse, ReplyWarning } from '../../../../shared/types';
import './batch.css';

export default function BatchPage() {
  const { brandParam } = useBrandScope();
  const { meta } = useMeta();
  const [platform, setPlatform] = useState('');
  const groups = useQuery(async () => {
    const r = await api.get<CommentGroupsResponse>('/batch/groups', { brand: brandParam, platform });
    syncServerTime(r.serverTime);
    return r;
  }, [brandParam, platform]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const now = useNow();
  const list = groups.data?.groups ?? [];
  const selected = list.find((g) => g.key === selectedKey) ?? null;

  useEffect(() => {
    if (selectedKey && groups.data && !groups.data.groups.some((g) => g.key === selectedKey)) setSelectedKey(null);
  }, [groups.data, selectedKey]);

  return (
    <>
      <PageHeader
        title="相似留言"
        description="同一篇貼文、廣告或影片底下問同一件事的留言會自動分成一組，可以一次產生回覆、逐則確認後送出。客訴、退款、敏感或有風險的留言不會被分組，請在收件匣個別處理。"
        actions={
          <div className="row">
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="平台" style={{ width: 'auto' }}>
              <option value="">全部平台</option>
              {(meta?.platforms ?? []).map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </Select>
            <Button icon={<IconRefresh />} onClick={() => void groups.reload()} loading={groups.loading && !!groups.data}>
              重新整理
            </Button>
          </div>
        }
      />
      {groups.loading && !groups.data ? (
        <Loading />
      ) : groups.error ? (
        <ErrorMessage error={groups.error} onRetry={() => void groups.reload()} />
      ) : (
        <>
          {(groups.data?.individualCount ?? 0) > 0 && (
            <Alert tone="warning">
              另有 <strong>{groups.data!.individualCount}</strong> 則待處理留言涉及客訴、退款、敏感或風險，需要個別處理，沒有放進任何組。
              <Link to="/inbox"> 到收件匣處理 →</Link>
            </Alert>
          )}
          {list.length === 0 ? (
            <Card>
              <EmptyState
                title="目前沒有相似留言"
                description="同一篇內容有 2 則以上問同一件事的待處理留言時，會出現在這裡。可以到「自動回覆 → 測試與模擬」用「模擬大量留言」試試看。"
              />
            </Card>
          ) : (
            <div className={`bt-layout ${selected ? 'has-selected' : ''}`}>
              <ul className="bt-groups" aria-label="相似留言分組">
                {list.map((g) => (
                  <li key={g.key}>
                    <button type="button" className={`bt-group ${g.key === selectedKey ? 'active' : ''}`} onClick={() => setSelectedKey(g.key)}>
                      <span className="bt-group-head">
                        <PlatformIcon platform={g.platform} size={18} />
                        <strong>{g.label}</strong>
                        <Badge tone={g.replyable ? 'blue' : 'gray'}>{g.comments.length} 則</Badge>
                      </span>
                      <span className="small muted bt-ellipsis">
                        {CONTENT_TYPE_LABELS[g.contentType]}｜{g.postTitle}
                      </span>
                      <span className="row-wrap small">
                        <BrandTag name={g.brandName} color={g.brandColor} />
                        <SlaChip size="sm" now={now} c={{ status: 'pending', slaDueAt: g.earliestDueAt, firstResponseAt: null, nearDueMinutes: DEFAULT_NEAR_DUE_MINUTES }} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="bt-panel">
                {selected ? (
                  <GroupPanel key={selected.key} group={selected} now={now} onBack={() => setSelectedKey(null)} onDone={() => void groups.reload()} />
                ) : (
                  <Card>
                    <EmptyState title="選擇左邊的一組留言" description="可以一次產生回覆、逐則修改，確認後批次送出。" />
                  </Card>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

interface Draft {
  commentId: number;
  authorName: string;
  commentBody: string;
  suggestionId: number;
  body: string;
  original: string;
  warnings: ReplyWarning[];
  include: boolean;
}

function GroupPanel({ group, now, onBack, onDone }: { group: CommentGroup; now: number; onBack: () => void; onDone: () => void }) {
  const toast = useToast();
  const available = group.comments.filter((c) => !c.lockedByName);
  const [picked, setPicked] = useState<number[]>(() => available.map((c) => c.id));
  const [busy, setBusy] = useState<'suggest' | 'send' | 'mark' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<BatchSuggestResponse | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [variantKey, setVariantKey] = useState<string>('');
  const [statusAfter, setStatusAfter] = useState<'waiting' | 'done'>('waiting');
  const [confirmed, setConfirmed] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmMark, setConfirmMark] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);

  const included = drafts.filter((d) => d.include);
  const needConfirm = included.some((d) => d.warnings.length > 0);
  const blocked = included.some((d) => d.warnings.some((w) => w.level === 'block'));
  const nameOf = useMemo(() => new Map(group.comments.map((c) => [c.id, c.authorName])), [group.comments]);

  const generate = async (key = variantKey) => {
    if (picked.length === 0) return setError('請至少選擇一則留言');
    setBusy('suggest');
    setError(null);
    setResult(null);
    try {
      const r = await api.post<BatchSuggestResponse>('/batch/suggest', { commentIds: picked, variantKey: key || undefined });
      setSuggest(r);
      setVariantKey(r.variantKey);
      setDrafts(r.drafts.map((d) => ({ ...d, original: d.body, include: true })));
      setConfirmed(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    setBusy('send');
    setError(null);
    try {
      const r = await api.post<BatchResult>('/batch/reply', {
        batchId: suggest?.batchId,
        statusAfter,
        confirmWarnings: confirmed,
        items: included.map((d) => ({ commentId: d.commentId, body: d.body.trim(), suggestionId: d.suggestionId })),
      });
      setResult(r);
      setConfirmSend(false);
      if (r.failed === 0) toast.success(`已送出 ${r.succeeded} 則回覆`);
      else toast.error(`送出 ${r.succeeded} 則，${r.failed} 則失敗`);
      // 已送出的從草稿移除，失敗的留著可以重送
      setDrafts((ds) => ds.filter((d) => !r.results.some((x) => x.commentId === d.commentId && x.ok)));
      onDone();
    } catch (err) {
      setConfirmSend(false);
      if (err instanceof ApiError && (err.code === 'reply_warnings' || err.code === 'reply_blocked')) {
        const items = (err.details as { items?: Array<{ commentId: number; warnings: ReplyWarning[] }> })?.items ?? [];
        setDrafts((ds) => ds.map((d) => ({ ...d, warnings: items.find((x) => x.commentId === d.commentId)?.warnings ?? d.warnings })));
      }
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const mark = async (reason: string) => {
    setBusy('mark');
    setError(null);
    try {
      const r = await api.post<BatchResult>('/batch/status', { commentIds: picked, status: 'no_action', reason: reason || undefined });
      setConfirmMark(false);
      setResult(r);
      if (r.failed === 0) toast.success(`已將 ${r.succeeded} 則標記為無需處理`);
      else toast.error(`${r.succeeded} 則已標記，${r.failed} 則失敗`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const setDraft = (id: number, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.commentId === id ? { ...d, ...patch } : d)));

  return (
    <Card
      title={
        <div className="bt-panel-title">
          <Button size="sm" variant="ghost" className="bt-back" onClick={onBack}>
            ← 返回
          </Button>
          <PlatformIcon platform={group.platform} size={20} />
          <h2>{group.label}</h2>
          <Badge tone="blue">{group.comments.length} 則</Badge>
        </div>
      }
    >
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          {group.accountName}・{CONTENT_TYPE_LABELS[group.contentType]}
          {group.isAd ? '（廣告）' : ''}｜{group.postTitle}
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        {result && result.failed > 0 && (
          <Alert tone="warning">
            <strong>{result.failed} 則沒有成功：</strong>
            <ul className="bt-fail">
              {result.results
                .filter((x) => !x.ok)
                .map((x) => (
                  <li key={x.commentId}>
                    {nameOf.get(x.commentId) ?? `#${x.commentId}`}：{x.error}
                  </li>
                ))}
            </ul>
          </Alert>
        )}

        {!suggest ? (
          <>
            <div className="row-wrap">
              <Checkbox
                label={`全選（${available.length} 則可處理）`}
                checked={picked.length === available.length && available.length > 0}
                onChange={(v) => setPicked(v ? available.map((c) => c.id) : [])}
              />
            </div>
            <ul className="bt-comments">
              {group.comments.map((c) => (
                <li key={c.id} className={c.lockedByName ? 'locked' : ''}>
                  <Checkbox
                    label={<span className="sr-only">選取 {c.authorName} 的留言</span>}
                    disabled={!!c.lockedByName}
                    checked={picked.includes(c.id)}
                    onChange={(v) => setPicked((p) => (v ? [...p, c.id] : p.filter((x) => x !== c.id)))}
                  />
                  <div className="bt-comment-main">
                    <div className="row-wrap small">
                      <strong>{c.authorName}</strong>
                      <span className="muted">{formatShortDateTime(c.occurredAt)}</span>
                      <Badge>{STATUS_LABELS[c.status]}</Badge>
                      <SlaChip size="sm" now={now} c={{ status: c.status, slaDueAt: c.slaDueAt, firstResponseAt: c.firstResponseAt, nearDueMinutes: DEFAULT_NEAR_DUE_MINUTES }} />
                      {c.assigneeName && <span className="muted">負責：{c.assigneeName}</span>}
                      {c.lockedByName && <Badge tone="orange">{c.lockedByName} 處理中</Badge>}
                    </div>
                    <p>{c.body}</p>
                  </div>
                  <Link className="small" to={`/inbox/${c.id}`}>
                    詳情
                  </Link>
                </li>
              ))}
            </ul>
            <div className="row-wrap">
              {group.replyable && (
                <Button variant="primary" loading={busy === 'suggest'} disabled={picked.length === 0} onClick={() => void generate()}>
                  產生 AI 回覆（{picked.length} 則）
                </Button>
              )}
              <Button loading={busy === 'mark'} disabled={picked.length === 0} onClick={() => setConfirmMark(true)}>
                標記無需處理（{picked.length} 則）
              </Button>
            </div>
            {!group.replyable && <p className="small muted">疑似垃圾訊息不提供批次回覆。若需要隱藏或刪除，請在收件匣逐則確認。</p>}
          </>
        ) : (
          <>
            {suggest.notes.map((n) => (
              <Alert key={n} tone={n.startsWith('知識不足') ? 'warning' : 'info'}>
                {n}
              </Alert>
            ))}
            {suggest.hits.length > 0 && (
              <details className="bt-knowledge">
                <summary className="small">引用的知識（{suggest.hits.length}）</summary>
                <ul className="small">
                  {suggest.hits.map((h) => (
                    <li key={h.id}>
                      <strong>{h.title}</strong>：{h.content}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="row-wrap">
              <span className="small">回覆版本：</span>
              <Select value={variantKey} onChange={(e) => setVariantKey(e.target.value)} style={{ width: 'auto' }} aria-label="回覆版本">
                {suggest.variants.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.label}
                  </option>
                ))}
              </Select>
              <Button size="sm" loading={busy === 'suggest'} onClick={() => void generate(variantKey)}>
                重新產生
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setSuggest(null); setDrafts([]); setResult(null); }}>
                重新選取留言
              </Button>
            </div>
            {drafts.length === 0 ? (
              <EmptyState title="這批已全部處理完" description="可以返回選擇其他組。" />
            ) : (
              <ul className="bt-drafts">
                {drafts.map((d) => (
                  <li key={d.commentId} className={d.include ? '' : 'off'}>
                    <div className="row-wrap small">
                      <Checkbox label={<strong>{d.authorName}</strong>} checked={d.include} onChange={(v) => setDraft(d.commentId, { include: v })} />
                      <span className="muted bt-ellipsis">「{d.commentBody}」</span>
                      {d.body !== d.original && <Badge tone="purple">已修改</Badge>}
                    </div>
                    <Textarea
                      rows={5}
                      value={d.body}
                      disabled={!d.include}
                      maxLength={2000}
                      onChange={(e) => setDraft(d.commentId, { body: e.target.value })}
                      aria-label={`回覆 ${d.authorName}`}
                    />
                    {d.warnings.length > 0 && (
                      <ul className="bt-warnings small">
                        {d.warnings.map((w) => (
                          <li key={w.message} className={w.level === 'block' ? 'block' : ''}>
                            {w.level === 'block' ? '⛔ ' : '⚠ '}
                            {w.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {drafts.length > 0 && (
              <div className="bt-send">
                <div className="row-wrap">
                  <span className="small">回覆後狀態：</span>
                  <label className="checkbox">
                    <input type="radio" name="statusAfter" checked={statusAfter === 'waiting'} onChange={() => setStatusAfter('waiting')} />
                    <span>等待對方（需要對方再回應，例如請私訊）</span>
                  </label>
                  <label className="checkbox">
                    <input type="radio" name="statusAfter" checked={statusAfter === 'done'} onChange={() => setStatusAfter('done')} />
                    <span>已完成</span>
                  </label>
                </div>
                {needConfirm && !blocked && (
                  <Checkbox label="我已確認上方提醒（金額、日期、承諾等）沒有問題" checked={confirmed} onChange={setConfirmed} />
                )}
                {blocked && <Alert tone="danger">有回覆使用了品牌禁用詞，請修改或取消勾選後再送出。</Alert>}
                <div>
                  <Button
                    variant="primary"
                    disabled={included.length === 0 || blocked || (needConfirm && !confirmed) || included.some((d) => !d.body.trim())}
                    loading={busy === 'send'}
                    onClick={() => setConfirmSend(true)}
                  >
                    確認送出 {included.length} 則
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmSend}
        title={`送出 ${included.length} 則回覆？`}
        message={`會以你的名義在平台上逐則回覆，回覆後狀態改為「${STATUS_LABELS[statusAfter]}」。每一則都會各自留下回覆與操作紀錄。`}
        confirmText="確認送出"
        busy={busy === 'send'}
        onCancel={() => setConfirmSend(false)}
        onConfirm={() => void send()}
      />
      <ConfirmDialog
        open={confirmMark}
        title={`將 ${picked.length} 則標記為無需處理？`}
        message="這些留言不會回覆，狀態改為「無需處理」，並各自留下操作紀錄。"
        confirmText="標記無需處理"
        busy={busy === 'mark'}
        onCancel={() => setConfirmMark(false)}
        onConfirm={() => void mark('')}
      />
    </Card>
  );
}
