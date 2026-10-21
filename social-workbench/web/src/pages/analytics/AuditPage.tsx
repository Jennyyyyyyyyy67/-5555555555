// 操作紀錄：誰在何時做了什麼（回覆、修改 AI 建議、轉交、狀態、隱藏、刪除、自動化規則…），可篩選與查看細節。紀錄只能新增，不能修改或刪除。
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useBrandScope } from '../../brand/BrandScope';
import { api } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { formatDateTime } from '../../lib/format';
import { Badge, Button, Card, EmptyState, ErrorMessage, Loading, PageHeader, Select, TextInput } from '../../components/ui';
import type { AuditQueryResponse } from '../../../../shared/types';
import './analytics.css';

const GROUPS: Array<[string, string]> = [
  ['', '全部操作'],
  ['reply', '回覆'],
  ['status', '狀態變更'],
  ['assign', '指派／轉交／鎖定'],
  ['ai', 'AI 判斷與建議'],
  ['moderation', '按讚／隱藏／刪除／封鎖'],
  ['settings', '設定與規則'],
  ['auth', '登入'],
];
const ACTORS: Array<[string, string]> = [
  ['', '全部執行者'],
  ['user', '人員'],
  ['ai', 'AI'],
  ['rule', '自動化規則'],
  ['system', '系統'],
];
const SOURCE_LABELS: Record<string, string> = { manual: '人工撰寫', ai_adopted: '直接採用 AI 建議', ai_edited: '修改 AI 建議後送出', canned: '使用標準回覆', batch: '批次回覆', auto_rule: '自動回覆規則' };

type Item = AuditQueryResponse['items'][number];

function actorBadge(i: Item) {
  if (i.actorType === 'user') return <Badge tone="blue">{i.actorName ?? '人員'}</Badge>;
  if (i.actorType === 'ai') return <Badge tone="purple">AI{i.actorName ? `（${i.actorName} 要求）` : ''}</Badge>;
  if (i.actorType === 'rule') return <Badge tone="teal">自動化規則</Badge>;
  return <Badge>系統</Badge>;
}

function Detail({ i }: { i: Item }) {
  const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v, null, 2));
  return (
    <div className="an-audit-detail small">
      {i.replyBody && (
        <div className="an-audit-reply">
          <div>
            <span className="muted">送出內容（{SOURCE_LABELS[i.replySource ?? ''] ?? i.replySource}）</span>
            <blockquote>{i.replyBody}</blockquote>
          </div>
          {i.aiOriginalBody && i.aiOriginalBody !== i.replyBody && (
            <div>
              <span className="muted">原始 AI 建議</span>
              <blockquote className="an-ai-original">{i.aiOriginalBody}</blockquote>
            </div>
          )}
        </div>
      )}
      {(i.before !== null || i.after !== null) && (
        <div className="an-audit-diff">
          {json(i.before) && (
            <div>
              <span className="muted">變更前</span>
              <pre>{json(i.before)}</pre>
            </div>
          )}
          {json(i.after) && (
            <div>
              <span className="muted">變更後</span>
              <pre>{json(i.after)}</pre>
            </div>
          )}
        </div>
      )}
      {json(i.detail) && (
        <details>
          <summary className="muted">其他細節</summary>
          <pre>{json(i.detail)}</pre>
        </details>
      )}
      <span className="muted">動作代碼：{i.action}</span>
    </div>
  );
}

export default function AuditPage() {
  const { brandParam } = useBrandScope();
  const [form, setForm] = useState({ group: '', actorType: '', q: '', commentId: '', from: '', to: '' });
  const [applied, setApplied] = useState(form);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery(
    () => api.get<AuditQueryResponse>('/audit', { brand: brandParam, ...applied, page, pageSize: 30 }),
    [brandParam, applied, page],
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setApplied(form);
  };
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;

  return (
    <>
      <PageHeader title="操作紀錄" description="所有重要操作都會留下紀錄：誰回覆、是否採用或修改 AI 建議、誰轉交、誰變更狀態、誰隱藏或刪除留言，以及哪些動作由自動化規則執行。紀錄無法修改或刪除。" />
      <Card>
        <form className="an-audit-filters" onSubmit={submit}>
          <Select value={form.group} onChange={(e) => set('group', e.target.value)} aria-label="操作類別">
            {GROUPS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
          <Select value={form.actorType} onChange={(e) => set('actorType', e.target.value)} aria-label="執行者">
            {ACTORS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
          <TextInput value={form.q} onChange={(e) => set('q', e.target.value)} placeholder="搜尋內容或人員名稱" aria-label="關鍵字" />
          <TextInput value={form.commentId} inputMode="numeric" onChange={(e) => set('commentId', e.target.value.replace(/\D/g, ''))} placeholder="留言編號" aria-label="留言編號" />
          <TextInput type="date" value={form.from} onChange={(e) => set('from', e.target.value)} aria-label="開始日期" />
          <TextInput type="date" value={form.to} onChange={(e) => set('to', e.target.value)} aria-label="結束日期" />
          <Button type="submit" variant="primary">
            篩選
          </Button>
        </form>
      </Card>
      {q.loading && !q.data ? (
        <Loading />
      ) : q.error ? (
        <ErrorMessage error={q.error} onRetry={() => void q.reload()} />
      ) : q.data && q.data.items.length === 0 ? (
        <Card>
          <EmptyState title="沒有符合條件的紀錄" />
        </Card>
      ) : q.data ? (
        <Card bodyClassName="">
          <ul className="an-audit">
            {q.data.items.map((i) => (
              <li key={i.id}>
                <button type="button" className="an-audit-row" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? null : i.id)}>
                  <span className="an-audit-time small muted">{formatDateTime(i.createdAt)}</span>
                  <span className="an-audit-actor">{actorBadge(i)}</span>
                  <span className="an-audit-summary">
                    {i.summary}
                    {i.brandName && <span className="muted small">・{i.brandName}</span>}
                  </span>
                </button>
                {open === i.id && (
                  <div className="an-audit-open">
                    {i.commentId && (
                      <Link className="small" to={`/inbox/${i.commentId}`}>
                        開啟留言 #{i.commentId} →
                      </Link>
                    )}
                    <Detail i={i} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="an-pager">
            <span className="small muted">
              共 {q.data.total} 筆・第 {q.data.page} / {pages} 頁
            </span>
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              上一頁
            </Button>
            <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              下一頁
            </Button>
          </div>
        </Card>
      ) : null}
    </>
  );
}
