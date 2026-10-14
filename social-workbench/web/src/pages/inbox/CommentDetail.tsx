// 收件匣右側：單則留言的詳情與所有處理動作
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { api, ApiError, errorMessage } from '../../lib/api';
import { formatDateTime, formatShortDateTime } from '../../lib/format';
import { useToast } from '../../components/Toast';
import { Avatar, Badge, Button, ConfirmDialog, Dropdown, ErrorMessage, Field, Loading, Modal, PRIORITY_TONE, STATUS_TONE, Select, TextInput, Textarea } from '../../components/ui';
import { BrandTag, IconChevronDown, IconShield, IconX, PlatformIcon } from '../../components/icons';
import {
  CONTENT_TYPE_LABELS,
  HIGH_RISK_ACTIONS,
  INTERACTION_ACTION_LABELS,
  OPEN_STATUSES,
  PRIORITY_LABELS,
  PRIORITIES,
  RISK_FLAG_LABELS,
  RISK_LEVEL_LABELS,
  ROLE_LABELS,
  SENTIMENT_LABELS,
  STATUS_LABELS,
  type InteractionAction,
} from '../../../../shared/constants';
import type { CommentDetail, ReplyInput } from '../../../../shared/types';
import { SlaChip, syncServerTime, useNow } from './sla';
import { ReplyComposer } from './ReplyComposer';
import { useMeta } from '../../lib/meta';

interface Props {
  id: number;
  onClose: () => void;
  onChanged: () => void;
  onFilterPost: (postId: number) => void;
}

export default function CommentDetailPane({ id, onClose, onChanged, onFilterPost }: Props) {
  const { user, can } = useAuth();
  const toast = useToast();
  const now = useNow(15_000);
  const [d, setD] = useState<CommentDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lockMine = useRef(false);

  const apply = useCallback((res: CommentDetail) => {
    syncServerTime(res.serverTime);
    lockMine.current = !!res.lock?.isMine;
    setD(res);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api.get<CommentDetail>(`/comments/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id, apply]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  // 處理中：每 3 分鐘延長鎖定；離開這則留言時自動釋放
  useEffect(() => {
    const t = setInterval(() => {
      if (lockMine.current) void api.post(`/comments/${id}/lock`).catch(() => {});
    }, 180_000);
    return () => {
      clearInterval(t);
      if (lockMine.current) {
        lockMine.current = false;
        void api.del(`/comments/${id}/lock`).then(onChanged, () => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /** 執行一個會回傳最新詳情的動作 */
  const act = async (key: string, fn: () => Promise<CommentDetail>, okMsg?: string): Promise<boolean> => {
    setBusy(key);
    try {
      apply(await fn());
      if (okMsg) toast.success(okMsg);
      onChanged();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      if (err instanceof ApiError && err.status === 409) void load();
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (error && !d) return <div className="detail-pad"><ErrorMessage error={error} onRetry={() => void load()} /></div>;
  if (!d || !user) return <Loading />;

  const c = d.comment;
  const isOpen = OPEN_STATUSES.includes(c.status);
  const lockedByOther = d.lock && !d.lock.isMine;
  const canWrite = d.permissions.canHandle;
  const caps = d.account.capabilities;

  const startHandling = (force = false) =>
    act('lock', () => api.post<CommentDetail>(`/comments/${id}/lock`, { force }), force ? '已接手處理' : undefined);
  const release = () => act('release', () => api.del<CommentDetail>(`/comments/${id}/lock`), '已暫停處理，其他人可以接手');

  return (
    <div className="detail">
      <header className="detail-head">
        <Button variant="ghost" size="sm" className="detail-back" onClick={onClose} aria-label="回到列表">
          ← 列表
        </Button>
        <div className="detail-title">
          <div className="row-wrap">
            <BrandTag name={c.brandName} color={c.brandColor} />
            <PlatformIcon platform={c.platform} size={18} />
            <span className="small text-2">{d.account.name}</span>
            <span className="muted small">・{CONTENT_TYPE_LABELS[c.contentType]}</span>
          </div>
          <div className="row-wrap" style={{ marginTop: 6 }}>
            <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABELS[c.status]}</Badge>
            {c.priority && <Badge tone={PRIORITY_TONE[c.priority]}>優先級：{PRIORITY_LABELS[c.priority]}</Badge>}
            {c.needsHuman && (
              <Badge tone="orange" title="涉及客訴、退款、敏感議題或無法確認的承諾，AI 不會自動回覆">
                <IconShield size={12} /> 需人工處理
              </Badge>
            )}
            {c.isAutoHandled && <Badge tone="purple">AI 自動處理</Badge>}
            {c.visibility !== 'visible' && <Badge tone="gray">{c.visibility === 'hidden' ? '已隱藏' : '已刪除'}</Badge>}
            <SlaChip c={c} now={now} />
          </div>
        </div>
        <Button variant="ghost" size="sm" iconOnly className="detail-close" aria-label="關閉" icon={<IconX />} onClick={onClose} />
      </header>

      <LockBanner d={d} busy={busy} isOpen={isOpen} onStart={startHandling} onRelease={release} />

      <div className="detail-body">
        <div className="detail-main">
          <PostCard d={d} onFilterPost={onFilterPost} />
          <Thread d={d} />
          {isOpen || c.status === 'waiting' ? (
            caps.reply && c.visibility !== 'deleted' ? (
              <ReplyComposer
                key={c.id}
                commentId={c.id}
                disabled={!canWrite}
                lockMine={!!d.lock?.isMine}
                onFocusStart={() => {
                  if (!d.lock && canWrite) void startHandling();
                }}
                onSent={(nd, msg) => {
                  apply(nd);
                  toast.success(msg);
                  onChanged();
                }}
              />
            ) : (
              <p className="muted small detail-pad-x">{c.visibility === 'deleted' ? '留言已刪除，無法回覆。' : '這個平台／帳號類型不支援透過系統回覆。'}</p>
            )
          ) : null}
          <StatusBar d={d} busy={busy} act={act} />
        </div>

        <aside className="detail-side">
          <AssignCard d={d} busy={busy} act={act} />
          <TimesCard d={d} />
          <AnalysisCard d={d} busy={busy} act={act} />
          <FollowUpCard d={d} busy={busy} act={act} />
          <NotesCard d={d} busy={busy} act={act} />
          <ActionsCard d={d} busy={busy} act={act} />
          {can('testAutomation') && <SimulateFollowUp d={d} onDone={() => { void load(); onChanged(); }} />}
          <HistoryCard d={d} />
        </aside>
      </div>
      {lockedByOther && <div className="sr-only">這則留言正由 {d.lock!.byName} 處理中，只能檢視</div>}
    </div>
  );
}

type Act = (key: string, fn: () => Promise<CommentDetail>, okMsg?: string) => Promise<boolean>;

// ---------- 處理中鎖定 ----------
function LockBanner({ d, busy, isOpen, onStart, onRelease }: { d: CommentDetail; busy: string | null; isOpen: boolean; onStart: (force?: boolean) => void; onRelease: () => void }) {
  const [confirm, setConfirm] = useState(false);
  if (d.lock && !d.lock.isMine) {
    return (
      <div className="lock-banner other" role="status">
        <span>
          🔒 <strong>{d.lock.byName}</strong> 正在處理這則留言（{formatShortDateTime(d.lock.expiresAt)} 前未動作會自動釋放），你目前只能檢視。
        </span>
        {d.permissions.canOverrideLock && (
          <>
            <Button size="sm" onClick={() => setConfirm(true)} loading={busy === 'lock'}>
              強制接手
            </Button>
            <ConfirmDialog
              open={confirm}
              title="強制接手這則留言？"
              message={`${d.lock.byName} 正在處理中，接手後對方會收到通知，且無法再送出回覆。`}
              confirmText="接手處理"
              onCancel={() => setConfirm(false)}
              onConfirm={() => {
                setConfirm(false);
                onStart(true);
              }}
            />
          </>
        )}
      </div>
    );
  }
  if (d.lock?.isMine) {
    return (
      <div className="lock-banner mine" role="status">
        <span>✋ 你正在處理這則留言，其他人暫時無法回覆。</span>
        <Button size="sm" variant="ghost" onClick={onRelease} loading={busy === 'release'}>
          暫停處理
        </Button>
      </div>
    );
  }
  if (isOpen && d.permissions.canHandle) {
    return (
      <div className="lock-banner idle">
        <span className="muted">開始處理後會標示為「處理中」，避免同事重複回覆。</span>
        <Button size="sm" variant="primary" onClick={() => onStart()} loading={busy === 'lock'}>
          開始處理
        </Button>
      </div>
    );
  }
  return null;
}

// ---------- 原始內容 ----------
function PostCard({ d, onFilterPost }: { d: CommentDetail; onFilterPost: (postId: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const long = d.post.body.length > 120;
  return (
    <section className="post-card">
      <div className="row-wrap small muted">
        <span>{CONTENT_TYPE_LABELS[d.post.contentType]}</span>
        {d.post.isAd && <Badge tone="orange">廣告{d.post.adCampaign ? `：${d.post.adCampaign}` : ''}</Badge>}
        <span>發布於 {formatShortDateTime(d.post.publishedAt)}</span>
        <span className="spacer" />
        <button className="link-btn" onClick={() => onFilterPost(d.post.id)}>
          只看這篇的留言
        </button>
        {d.post.url && (
          <a href={d.post.url} target="_blank" rel="noreferrer" className="small">
            開啟原文 ↗
          </a>
        )}
      </div>
      <h3>{d.post.title}</h3>
      {d.post.body && (
        <p className={`post-body ${expanded || !long ? '' : 'clamp'}`}>
          {d.post.body}
          {long && (
            <button className="link-btn" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '收起' : '展開'}
            </button>
          )}
        </p>
      )}
    </section>
  );
}

function Thread({ d }: { d: CommentDetail }) {
  return (
    <section className="thread" aria-label="留言串">
      {d.thread.map((t) =>
        t.kind === 'comment' ? (
          <div key={`c${t.id}`} className={`bubble ${t.isCurrent ? 'current' : ''} ${t.parentId ? 'child' : ''}`}>
            <div className="row-wrap small">
              <Avatar name={t.authorName} size="sm" />
              <strong>{t.authorName}</strong>
              {t.rating !== null && <span className="stars">{'★'.repeat(t.rating)}{'☆'.repeat(5 - t.rating)}</span>}
              <span className="muted" title={formatDateTime(t.occurredAt)}>
                {formatShortDateTime(t.occurredAt)}
              </span>
              {!t.isCurrent && <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABELS[t.status]}</Badge>}
              {t.isCurrent && <Badge tone="blue">目前這則</Badge>}
            </div>
            <p className={t.visibility === 'deleted' ? 'deleted' : ''}>{t.visibility === 'deleted' ? '（留言已刪除）' : t.body}</p>
          </div>
        ) : (
          <div key={`r${t.id}`} className="bubble reply">
            <div className="row-wrap small">
              <span className="brand-reply-tag">品牌回覆</span>
              <span className="muted">{t.source === 'auto_rule' ? 'AI 自動回覆' : (t.senderName ?? '')}</span>
              <span className="muted" title={formatDateTime(t.sentAt)}>
                {formatShortDateTime(t.sentAt)}
              </span>
            </div>
            <p>{t.body}</p>
          </div>
        ),
      )}
    </section>
  );
}

// ---------- 狀態 ----------
function StatusBar({ d, busy, act }: { d: CommentDetail; busy: string | null; act: Act }) {
  const [noAction, setNoAction] = useState(false);
  const c = d.comment;
  const id = c.id;
  const disabled = !d.permissions.canHandle;
  const setStatus = (status: string, reason?: string, msg?: string) => act(`status-${status}`, () => api.post<CommentDetail>(`/comments/${id}/status`, { status, reason }), msg);
  const closed = c.status === 'done' || c.status === 'no_action';
  return (
    <section className="status-bar">
      <span className="small muted">變更狀態：</span>
      {closed ? (
        <Button size="sm" disabled={disabled} loading={busy === 'status-pending'} onClick={() => void setStatus('pending', undefined, '已重新開啟')}>
          重新開啟
        </Button>
      ) : (
        <>
          {c.firstResponseAt && c.status !== 'waiting' && (
            <Button size="sm" disabled={disabled} loading={busy === 'status-waiting'} onClick={() => void setStatus('waiting', undefined, '已標示為等待對方')}>
              等待對方
            </Button>
          )}
          <Button size="sm" disabled={disabled} loading={busy === 'status-done'} onClick={() => void setStatus('done', undefined, '已標示為完成')}>
            標記完成
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setNoAction(true)}>
            不需處理
          </Button>
        </>
      )}
      <ConfirmDialog
        open={noAction}
        title="標示為不需處理？"
        message="這則留言會結案且不再計算回覆時效。"
        requireReason
        reasonPlaceholder="例如：重複留言、與品牌無關、灌水內容"
        confirmText="不需處理"
        busy={busy === 'status-no_action'}
        onCancel={() => setNoAction(false)}
        onConfirm={async (reason) => {
          if (await setStatus('no_action', reason, '已標示為不需處理')) setNoAction(false);
        }}
      />
    </section>
  );
}

// ---------- 側欄卡片 ----------
function SideCard({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="side-card">
      <div className="side-card-head">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function AssignCard({ d, busy, act }: { d: CommentDetail; busy: string | null; act: Act }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const c = d.comment;
  const mine = c.assigneeId === user!.id;
  const canTransfer = d.permissions.canReassign || mine || c.assigneeId === null;
  const assign = (assigneeId: number | null, why?: string, msg?: string) =>
    act('assign', () => api.post<CommentDetail>(`/comments/${c.id}/assign`, { assigneeId, reason: why || undefined }), msg);
  const others = d.directory.filter((u) => u.id !== c.assigneeId);
  return (
    <SideCard
      title="負責與處理"
      action={
        canTransfer && (
          <button className="link-btn" onClick={() => { setTo(''); setReason(''); setOpen(true); }}>
            {c.assigneeId ? '轉交' : '指派'}
          </button>
        )
      }
    >
      <dl className="kv">
        <dt>負責人</dt>
        <dd>
          {c.assigneeName ? (
            <span className="row">
              <Avatar name={c.assigneeName} size="sm" /> {c.assigneeName}
              {mine && <span className="muted small">（我）</span>}
            </span>
          ) : (
            <span className="row">
              <span className="muted">未指派</span>
              <Button size="sm" variant="ghost" loading={busy === 'assign'} onClick={() => void assign(user!.id, undefined, '已由你負責')}>
                我來負責
              </Button>
            </span>
          )}
        </dd>
        <dt>實際處理人</dt>
        <dd>{c.handledByName ?? <span className="muted">尚無</span>}</dd>
        {c.originalAssigneeName && c.originalAssigneeName !== c.assigneeName && (
          <>
            <dt>原負責人</dt>
            <dd>{c.originalAssigneeName}</dd>
          </>
        )}
      </dl>
      {d.assignments.length > 0 && (
        <ul className="mini-list">
          {d.assignments.slice(0, 3).map((a) => (
            <li key={a.id}>
              <span className="muted">{formatShortDateTime(a.createdAt)}</span> {a.fromName ?? '未指派'} → {a.toName ?? '未指派'}
              {a.reason && <span className="muted">（{a.reason}）</span>}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={open}
        title={c.assigneeId ? '轉交給其他人' : '指派負責人'}
        onClose={() => setOpen(false)}
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button
              variant="primary"
              disabled={!to}
              loading={busy === 'assign'}
              onClick={async () => {
                const target = to === 'none' ? null : Number(to);
                if (await assign(target, reason.trim(), target ? '已轉交' : '已取消指派')) setOpen(false);
              }}
            >
              確認
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="交給">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">請選擇人員</option>
              {others.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}（{ROLE_LABELS[u.role]}）{u.id === user!.id ? '・我' : ''}
                </option>
              ))}
              {d.permissions.canReassign && c.assigneeId && <option value="none">取消指派（回到未指派）</option>}
            </Select>
          </Field>
          <Field label="轉交原因（選填，對方會看到）">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：需要產品專業回覆、我今天休假" />
          </Field>
        </div>
      </Modal>
    </SideCard>
  );
}

function TimesCard({ d }: { d: CommentDetail }) {
  const c = d.comment;
  return (
    <SideCard title="時間紀錄">
      <dl className="kv">
        <dt>對方留言</dt>
        <dd>{formatDateTime(c.occurredAt)}</dd>
        <dt>系統抓取</dt>
        <dd>{formatDateTime(c.fetchedAt)}</dd>
        <dt>回覆時限</dt>
        <dd>{c.slaDueAt ? `${formatDateTime(c.slaDueAt)}（${c.slaMinutes} 分鐘）` : '此類型不計時'}</dd>
        <dt>首次回覆</dt>
        <dd>
          {c.firstResponseAt ? (
            <>
              {formatDateTime(c.firstResponseAt)}
              <div className="muted small">{c.firstResponseType === 'ai_auto' ? 'AI 自動回覆' : (c.firstResponseByName ?? '')}</div>
            </>
          ) : (
            <span className="muted">尚未回覆</span>
          )}
        </dd>
        <dt>完成時間</dt>
        <dd>{c.completedAt ? formatDateTime(c.completedAt) : <span className="muted">未完成</span>}</dd>
      </dl>
    </SideCard>
  );
}

function AnalysisCard({ d, busy, act }: { d: CommentDetail; busy: string | null; act: Act }) {
  const c = d.comment;
  const ai = d.ai;
  const { meta } = useMeta();
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState(c.categoryKey ?? '');
  const [prio, setPrio] = useState<string>(c.priority ?? 'medium');
  const [reason, setReason] = useState('');
  return (
    <SideCard
      title="AI 判斷"
      action={
        d.permissions.canHandle && (
          <button className="link-btn" onClick={() => { setCat(c.categoryKey ?? ''); setPrio(c.priority ?? 'medium'); setReason(''); setOpen(true); }}>
            修正
          </button>
        )
      }
    >
      <div className="row-wrap">
        {c.categoryName ? <Badge tone="blue">{c.categoryName}</Badge> : <span className="muted small">尚未分類</span>}
        {c.sentiment && <Badge tone={c.sentiment === 'negative' ? 'red' : c.sentiment === 'positive' ? 'green' : 'gray'}>{SENTIMENT_LABELS[c.sentiment]}</Badge>}
        {c.riskLevel && c.riskLevel !== 'none' && <Badge tone={c.riskLevel === 'high' ? 'solid-red' : 'orange'}>風險：{RISK_LEVEL_LABELS[c.riskLevel]}</Badge>}
        {ai?.knowledgeGap && <Badge tone="orange">知識不足</Badge>}
      </div>
      {c.riskFlags.length > 0 && (
        <div className="row-wrap" style={{ marginTop: 8 }}>
          {c.riskFlags.map((f) => (
            <Badge key={f} tone="red">
              {RISK_FLAG_LABELS[f]}
            </Badge>
          ))}
        </div>
      )}
      {ai && (
        <dl className="kv" style={{ marginTop: 8 }}>
          <dt>AI 信心</dt>
          <dd>{ai.confidence !== null ? `${Math.round(ai.confidence * 100)}%` : '—'}</dd>
          {ai.reasons.length > 0 && (
            <>
              <dt>判斷依據</dt>
              <dd>{ai.reasons.join('；')}</dd>
            </>
          )}
          {ai.forceHuman.length > 0 && (
            <>
              <dt>轉人工原因</dt>
              <dd>{ai.forceHuman.map((r) => r.label).join('；')}</dd>
            </>
          )}
        </dl>
      )}
      {ai?.correctedByName !== null && ai?.correctedByName !== undefined && (
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          ✎ {ai.correctedByName || '人工'}已修正{ai.originalCategoryName ? `（AI 原判斷：${ai.originalCategoryName}）` : ''}
        </p>
      )}
      {c.tags.length > 0 && <p className="small muted" style={{ margin: '8px 0 0' }}>標籤：{c.tags.join('、')}</p>}
      {c.needsHuman && <p className="small warn-text">⚠ 這則留言必須由人工判斷與回覆，AI 不會自動處理。</p>}
      <Modal
        open={open}
        title="修正 AI 判斷"
        size="sm"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button
              variant="primary"
              loading={busy === 'classify'}
              onClick={async () => {
                const ok = await act('classify', () => api.post<CommentDetail>(`/comments/${c.id}/classify`, { categoryKey: cat || undefined, priority: prio, reason: reason.trim() || undefined }), '已修正分類');
                if (ok) setOpen(false);
              }}
            >
              儲存
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="留言類型">
            <Select value={cat} onChange={(e) => setCat(e.target.value)}>
              {(meta?.categories ?? []).filter((x) => x.isActive).map((x) => (
                <option key={x.key} value={x.key}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="優先級">
            <Select value={prio} onChange={(e) => setPrio(e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="修正原因（選填）">
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：其實是團購詢問" maxLength={200} />
          </Field>
          <p className="muted small" style={{ margin: 0 }}>修正會留下紀錄，並依新類型重新計算尚未回覆留言的回覆時限。</p>
        </div>
      </Modal>
    </SideCard>
  );
}

function toIso(local: string): string | null {
  const t = new Date(local);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}
function toLocalInput(iso: string): string {
  const t = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`;
}

function FollowUpCard({ d, busy, act }: { d: CommentDetail; busy: string | null; act: Act }) {
  const c = d.comment;
  const [custom, setCustom] = useState('');
  const [note, setNote] = useState(c.followUpNote);
  const set = (at: string | null, msg: string) => act('follow', () => api.post<CommentDetail>(`/comments/${c.id}/follow-up`, { at, note: note.trim() || undefined }), msg);
  const quick = (label: string, compute: () => Date) => (
    <Button size="sm" variant="ghost" onClick={() => void set(compute().toISOString(), `已設定稍後追蹤（${label}）`)} disabled={busy === 'follow'}>
      {label}
    </Button>
  );
  const tomorrow9 = () => {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0, 0, 0);
    return t;
  };
  return (
    <SideCard title="稍後追蹤">
      {c.followUpAt ? (
        <div className="stack" style={{ gap: 6 }}>
          <div className={`follow-at ${Date.parse(c.followUpAt) <= Date.now() ? 'due' : ''}`}>
            📌 {formatDateTime(c.followUpAt)}
            {Date.parse(c.followUpAt) <= Date.now() && '（已到期）'}
          </div>
          {c.followUpNote && <div className="small">{c.followUpNote}</div>}
          <div>
            <Button size="sm" variant="ghost" loading={busy === 'follow'} onClick={() => void set(null, '已取消稍後追蹤')}>
              取消追蹤
            </Button>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="備註（選填），例如：確認對方有沒有收到換貨" maxLength={200} aria-label="追蹤備註" />
          <div className="row-wrap" style={{ gap: 4 }}>
            {quick('1 小時後', () => new Date(Date.now() + 3600_000))}
            {quick('明天 9:00', tomorrow9)}
            {quick('3 天後', () => new Date(Date.now() + 3 * 86400_000))}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <TextInput type="datetime-local" value={custom} min={toLocalInput(new Date().toISOString())} onChange={(e) => setCustom(e.target.value)} aria-label="自訂追蹤時間" />
            <Button
              size="sm"
              disabled={!custom || busy === 'follow'}
              onClick={() => {
                const at = toIso(custom);
                if (at) void set(at, '已設定稍後追蹤');
              }}
            >
              設定
            </Button>
          </div>
        </div>
      )}
    </SideCard>
  );
}

function renderMentions(body: string, names: string[]): ReactNode {
  if (names.length === 0) return body;
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'g');
  return body.split(re).map((part, i) => (i % 2 === 1 ? <span key={i} className="mention">{part}</span> : part));
}

function NotesCard({ d, busy, act }: { d: CommentDetail; busy: string | null; act: Act }) {
  const [body, setBody] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const names = d.directory.map((u) => u.name);
  const mention = (name: string) => {
    setBody((b) => `${b}${b && !b.endsWith(' ') ? ' ' : ''}@${name} `);
    ref.current?.focus();
  };
  return (
    <SideCard title={`內部備註${d.notes.length ? `（${d.notes.length}）` : ''}`}>
      <p className="muted small" style={{ margin: '0 0 8px' }}>只有團隊看得到，不會發布到平台。</p>
      {d.notes.length > 0 && (
        <ul className="notes">
          {d.notes.map((n) => (
            <li key={n.id}>
              <div className="row small">
                <Avatar name={n.userName} size="sm" />
                <strong>{n.userName}</strong>
                <span className="muted">{formatShortDateTime(n.createdAt)}</span>
              </div>
              <p>{renderMentions(n.body, names)}</p>
            </li>
          ))}
        </ul>
      )}
      <Textarea ref={ref} rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="寫下備註，可用 @ 提及同事" maxLength={1000} aria-label="新增備註" />
      <div className="row-wrap mention-chips">
        <span className="muted small">提及：</span>
        {d.directory.map((u) => (
          <button key={u.id} className="chip" onClick={() => mention(u.name)} type="button">
            @{u.name}
          </button>
        ))}
      </div>
      <div style={{ textAlign: 'right' }}>
        <Button
          size="sm"
          variant="primary"
          disabled={!body.trim()}
          loading={busy === 'note'}
          onClick={async () => {
            if (await act('note', () => api.post<CommentDetail>(`/comments/${d.comment.id}/notes`, { body: body.trim() }), '已新增備註')) setBody('');
          }}
        >
          新增備註
        </Button>
      </div>
    </SideCard>
  );
}

function ActionsCard({ d, busy, act }: { d: CommentDetail; busy: string | null; act: Act }) {
  const [confirm, setConfirm] = useState<InteractionAction | null>(null);
  const c = d.comment;
  const caps = d.account.capabilities;
  const options: InteractionAction[] = [];
  if (c.visibility !== 'deleted') {
    if (caps.like) options.push(c.isLiked ? 'unlike' : 'like');
    if (caps.hide) options.push(c.visibility === 'hidden' ? 'unhide' : 'hide');
    if (caps.delete) options.push('delete');
  }
  if (caps.block) options.push('block');
  const run = (action: InteractionAction, reason?: string) =>
    act(`action-${action}`, () => api.post<CommentDetail>(`/comments/${c.id}/actions`, { action, reason, confirm: HIGH_RISK_ACTIONS.includes(action) || undefined }), `已${INTERACTION_ACTION_LABELS[action]}`);
  const unsupported = (['like', 'hide', 'delete', 'block'] as const).filter((k) => !caps[k]);
  return (
    <SideCard title="互動動作">
      {options.length === 0 ? (
        <p className="muted small">此平台不支援透過系統操作。</p>
      ) : (
        <Dropdown
          align="left"
          trigger={({ toggle, open }) => (
            <Button size="sm" onClick={toggle} aria-expanded={open} disabled={!d.permissions.canHandle}>
              選擇動作 <IconChevronDown size={14} />
            </Button>
          )}
        >
          {(close) =>
            options.map((a) => (
              <button
                key={a}
                className={`menu-item ${HIGH_RISK_ACTIONS.includes(a) ? 'danger' : ''}`}
                role="menuitem"
                onClick={() => {
                  close();
                  if (HIGH_RISK_ACTIONS.includes(a)) setConfirm(a);
                  else void run(a);
                }}
              >
                {INTERACTION_ACTION_LABELS[a]}
                {HIGH_RISK_ACTIONS.includes(a) && <span className="muted small">需確認</span>}
              </button>
            ))
          }
        </Dropdown>
      )}
      {c.isLiked && <p className="small muted" style={{ margin: '8px 0 0' }}>👍 品牌已按讚</p>}
      {unsupported.length > 0 && <p className="small muted" style={{ margin: '8px 0 0' }}>此帳號類型不支援：{unsupported.map((k) => ({ like: '按讚', hide: '隱藏', delete: '刪除', block: '封鎖' })[k]).join('、')}</p>}
      {d.actions.length > 0 && (
        <ul className="mini-list">
          {d.actions.slice(0, 5).map((a) => (
            <li key={a.id}>
              <span className="muted">{formatShortDateTime(a.createdAt)}</span> {a.requestedByName ?? '系統'}：{INTERACTION_ACTION_LABELS[a.action as InteractionAction] ?? a.action}
              {a.reason && <span className="muted">（{a.reason}）</span>}
              {a.result === 'failed' && <Badge tone="red">失敗</Badge>}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!confirm}
        danger
        title={confirm === 'delete' ? '確定要刪除這則留言？' : '確定要封鎖／限制這位使用者？'}
        message={
          confirm === 'delete'
            ? `「${c.body.slice(0, 60)}${c.body.length > 60 ? '…' : ''}」刪除後無法在平台上復原。`
            : `${c.authorName} 將無法再於此帳號留言。這個動作會記錄在操作紀錄中。`
        }
        requireReason
        confirmText={confirm ? `確認${INTERACTION_ACTION_LABELS[confirm]}` : '確認'}
        busy={!!confirm && busy === `action-${confirm}`}
        onCancel={() => setConfirm(null)}
        onConfirm={async (reason) => {
          if (confirm && (await run(confirm, reason))) setConfirm(null);
        }}
      />
    </SideCard>
  );
}

function SimulateFollowUp({ d, onDone }: { d: CommentDetail; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const c = d.comment;
  return (
    <SideCard title="測試工具" action={!open && <button className="link-btn" onClick={() => setOpen(true)}>模擬對方追問</button>}>
      {open ? (
        <div className="stack" style={{ gap: 6 }}>
          <span className="small muted">以「{c.authorName}」身分在這則留言底下新增回應（只有測試用）。</span>
          <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="例如：請問什麼時候會寄出？" aria-label="模擬追問內容" />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!body.trim()}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.post('/automation/simulate', { postId: d.post.id, parentCommentId: c.id, authorName: c.authorName, body: body.trim() });
                  toast.success('已送出模擬追問，會以新留言出現在收件匣');
                  setBody('');
                  setOpen(false);
                  onDone();
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              送出
            </Button>
          </div>
        </div>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>測試「等待對方」後對方再留言時，留言會自動回到待處理。</p>
      )}
    </SideCard>
  );
}

function HistoryCard({ d }: { d: CommentDetail }) {
  const [all, setAll] = useState(false);
  const list = all ? d.history : d.history.slice(0, 6);
  return (
    <SideCard title="處理歷程">
      {d.history.length === 0 ? (
        <p className="muted small">尚無紀錄</p>
      ) : (
        <ol className="history">
          {list.map((h) => (
            <li key={h.id}>
              <span className={`dot actor-${h.actorType}`} aria-hidden />
              <div>
                <div className="small">{h.summary}</div>
                <div className="muted small">
                  {formatShortDateTime(h.createdAt)}
                  {h.actorType === 'rule' ? '・自動化規則' : h.actorType === 'ai' ? '・AI' : h.actorType === 'system' ? '・系統' : ''}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {d.history.length > 6 && (
        <button className="link-btn small" onClick={() => setAll((v) => !v)}>
          {all ? '收起' : `顯示全部 ${d.history.length} 筆`}
        </button>
      )}
    </SideCard>
  );
}
