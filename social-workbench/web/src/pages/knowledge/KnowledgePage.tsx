// 知識庫：AI 回覆只能引用這裡「已審核、啟用中、有效期限內」的品牌知識。
import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useBrandScope } from '../../brand/BrandScope';
import { api, errorMessage } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { formatDateTime, formatRelative } from '../../lib/format';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorMessage, Field, Loading, Modal, PageHeader, Select, Switch, TextInput, Textarea } from '../../components/ui';
import { BrandTag, IconEdit, IconPlus, IconSearch } from '../../components/icons';
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_CATEGORY_LABELS, type KnowledgeCategory } from '../../../../shared/constants';
import type { KnowledgeDetailResponse, KnowledgeInput, KnowledgeItem, KnowledgeListResponse, KnowledgeSearchResult } from '../../../../shared/types';
import './knowledge.css';

type Status = 'approved' | 'pending' | 'rejected' | 'expired' | 'inactive' | '';
const TABS: Array<{ key: Status; label: string; countKey: keyof KnowledgeListResponse['counts'] }> = [
  { key: 'approved', label: 'AI 可引用', countKey: 'approved' },
  { key: 'pending', label: '待審核', countKey: 'pending' },
  { key: 'rejected', label: '已退回', countKey: 'rejected' },
  { key: 'expired', label: '已過期', countKey: 'expired' },
  { key: 'inactive', label: '已停用', countKey: 'inactive' },
  { key: '', label: '全部', countKey: 'all' },
];

export default function KnowledgePage() {
  const { can, brands } = useAuth();
  const { brandParam } = useBrandScope();
  const toast = useToast();
  const approver = can('approveKnowledge');
  const [status, setStatus] = useState<Status>('approved');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const list = useQuery(() => api.get<KnowledgeListResponse>('/knowledge', { brand: brandParam, status, category, q: qDebounced }), [brandParam, status, category, qDebounced]);
  const [editing, setEditing] = useState<KnowledgeItem | 'new' | null>(null);
  const [history, setHistory] = useState<KnowledgeItem | null>(null);
  const [rejecting, setRejecting] = useState<KnowledgeItem | null>(null);
  const brandColor = (id: number) => brands.find((b) => b.id === id)?.color ?? '#9aa3af';

  const review = async (k: KnowledgeItem, decision: 'approve' | 'reject', note?: string) => {
    try {
      await api.post(`/knowledge/${k.id}/review`, { decision, note });
      toast.success(decision === 'approve' ? `已通過「${k.title}」，AI 之後會引用` : `已退回「${k.title}」`);
      setRejecting(null);
      await list.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const setActive = async (k: KnowledgeItem, isActive: boolean) => {
    try {
      await api.post(`/knowledge/${k.id}/active`, { isActive });
      toast.success(isActive ? '已啟用' : '已停用，AI 不會再引用這則知識');
      await list.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const counts = list.data?.counts;
  return (
    <>
      <PageHeader
        title="知識庫"
        description="AI 回覆建議只會引用「已審核、啟用中、在有效期限內」的知識；找不到相關知識時會標示「知識不足」，不會自己編造價格或規格。"
        actions={
          <Button variant="primary" icon={<IconPlus />} onClick={() => setEditing('new')}>
            {approver ? '新增知識' : '提出知識'}
          </Button>
        }
      />
      {!approver && <Alert>你提出的知識需要主管或管理員審核通過後，AI 才會引用。</Alert>}

      <div className="kb-layout">
        <div className="stack">
          <div className="kb-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.key} role="tab" aria-selected={status === t.key} className={`inbox-tab ${status === t.key ? 'active' : ''}`} onClick={() => setStatus(t.key)}>
                {t.label}
                {counts && <span className="count">{counts[t.countKey]}</span>}
              </button>
            ))}
          </div>
          <div className="toolbar">
            <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="知識分類" style={{ width: 'auto' }}>
              <option value="">全部分類</option>
              {KNOWLEDGE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {KNOWLEDGE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
            <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋標題、內容、關鍵字" aria-label="搜尋知識" style={{ maxWidth: 280 }} />
          </div>

          {list.error ? (
            <ErrorMessage error={list.error} onRetry={() => void list.reload()} />
          ) : list.loading && !list.data ? (
            <Loading />
          ) : list.data!.items.length === 0 ? (
            <Card>
              <EmptyState title="這個條件下沒有知識" description="可以按右上角新增，或切換其他分頁。" />
            </Card>
          ) : (
            <ul className="kb-list">
              {list.data!.items.map((k) => (
                <li key={k.id} className={`kb-item ${!k.isActive || k.isExpired ? 'off' : ''}`}>
                  <div className="row-wrap">
                    <strong>{k.title}</strong>
                    <Badge tone="blue">{KNOWLEDGE_CATEGORY_LABELS[k.category]}</Badge>
                    {k.reviewStatus === 'pending' && <Badge tone="orange">待審核</Badge>}
                    {k.reviewStatus === 'rejected' && <Badge tone="red">已退回</Badge>}
                    {k.isExpired && <Badge tone="gray">已過期</Badge>}
                    {k.isUpcoming && <Badge tone="teal">尚未生效</Badge>}
                    {!k.isActive && <Badge>已停用</Badge>}
                    <span className="spacer" />
                    <BrandTag name={k.brandName} color={brandColor(k.brandId)} />
                  </div>
                  <p className="kb-content">{k.content}</p>
                  <div className="row-wrap small">
                    <span className="muted">關鍵字：</span>
                    {k.keywords.map((w) => (
                      <span key={w} className="kb-kw">
                        {w}
                      </span>
                    ))}
                  </div>
                  <div className="row-wrap small muted">
                    {(k.validFrom || k.validTo) && <span>有效期間：{k.validFrom ?? '即日'} ～ {k.validTo ?? '不限'}</span>}
                    <span>第 {k.version} 版</span>
                    <span title={formatDateTime(k.updatedAt)}>
                      {k.updatedByName ?? ''} 更新於 {formatRelative(k.updatedAt)}
                    </span>
                    {k.approvedByName && k.reviewStatus === 'approved' && <span>審核：{k.approvedByName}</span>}
                  </div>
                  <div className="row-wrap kb-actions">
                    {approver && k.reviewStatus === 'pending' && (
                      <>
                        <Button size="sm" variant="primary" onClick={() => void review(k, 'approve')}>
                          審核通過
                        </Button>
                        <Button size="sm" onClick={() => setRejecting(k)}>
                          退回
                        </Button>
                      </>
                    )}
                    {(approver || k.reviewStatus !== 'approved') && (
                      <Button size="sm" variant="ghost" icon={<IconEdit />} onClick={() => setEditing(k)}>
                        編輯
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setHistory(k)}>
                      版本紀錄
                    </Button>
                    {approver && <Switch checked={k.isActive} onChange={(v) => void setActive(k, v)} label={k.isActive ? '啟用' : '停用'} />}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <SearchTester />
      </div>

      {editing && <KnowledgeModal item={editing === 'new' ? null : editing} approver={approver} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />}
      {history && <HistoryModal item={history} onClose={() => setHistory(null)} />}
      <ConfirmDialog
        open={!!rejecting}
        title={`退回「${rejecting?.title ?? ''}」？`}
        message="提出的人會在知識庫看到退回原因，修改後會重新送審。"
        requireReason
        reasonLabel="退回原因"
        reasonPlaceholder="例如：價格需以官網為準，請附上來源"
        confirmText="退回"
        onCancel={() => setRejecting(null)}
        onConfirm={(note) => rejecting && void review(rejecting, 'reject', note)}
      />
    </>
  );
}

function SearchTester() {
  const { activeBrands, currentBrand } = useBrandScope();
  const [brandId, setBrandId] = useState(currentBrand?.id ?? activeBrands[0]?.id ?? 0);
  const [body, setBody] = useState('');
  const [res, setRes] = useState<KnowledgeSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await api.post<KnowledgeSearchResult>('/knowledge/search', { brandId, body }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="試試看：AI 會找到哪些知識？" className="kb-tester">
      <div className="stack">
        <Select value={brandId} onChange={(e) => setBrandId(Number(e.target.value))} aria-label="品牌">
          {activeBrands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
        <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="輸入一則顧客留言，例如：耶誕禮盒多少錢？" aria-label="測試留言" />
        <Button variant="primary" icon={<IconSearch size={16} />} onClick={() => void run()} loading={busy} disabled={!body.trim()}>
          搜尋
        </Button>
        {error && <Alert tone="danger">{error}</Alert>}
        {res && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="small">
              AI 判斷類型：<Badge tone="blue">{res.categoryName}</Badge>
            </div>
            {res.hits.length === 0 ? (
              <Alert tone={res.needsKnowledge ? 'warning' : 'info'}>
                {res.needsKnowledge ? '找不到相關知識 → AI 會標示「知識不足」，只建議不含事實的回覆，並提醒小編確認。' : '這類留言不需要事實知識（例如稱讚、一般互動）。'}
              </Alert>
            ) : (
              res.hits.map((h) => (
                <div key={h.id} className="kb-hit">
                  <strong className="small">📘 {h.title}</strong>
                  <p className="small">{h.content}</p>
                  <span className="muted small">命中：{h.matched.join('、')}</span>
                </div>
              ))
            )}
            {res.skipped.map((s) => (
              <p key={s.id} className="small muted" style={{ margin: 0 }}>
                略過「{s.title}」：{s.reason}
              </p>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

/** 從留言收件匣把人工答案存成知識時帶入的內容 */
export interface KnowledgePreset {
  brandId: number;
  title: string;
  content: string;
  sourceCommentId: number;
}

export function KnowledgeModal({ item, preset, approver, onClose, onSaved }: { item: KnowledgeItem | null; preset?: KnowledgePreset; approver: boolean; onClose: () => void; onSaved: () => void }) {
  const { activeBrands, currentBrand } = useBrandScope();
  const toast = useToast();
  const [form, setForm] = useState({
    brandId: item?.brandId ?? preset?.brandId ?? currentBrand?.id ?? activeBrands[0]?.id ?? 0,
    category: (item?.category ?? 'faq') as KnowledgeCategory,
    title: item?.title ?? preset?.title ?? '',
    content: item?.content ?? preset?.content ?? '',
    keywords: (item?.keywords ?? []).join('、'),
    validFrom: item?.validFrom ?? '',
    validTo: item?.validTo ?? '',
    note: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async () => {
    const keywords = form.keywords.split(/[、,，\n]/).map((k) => k.trim()).filter(Boolean);
    setSaving(true);
    setError(null);
    try {
      const body: Omit<KnowledgeInput, 'brandId'> = { category: form.category, title: form.title, content: form.content, keywords, validFrom: form.validFrom || null, validTo: form.validTo || null };
      if (item) await api.patch(`/knowledge/${item.id}`, { ...body, note: form.note || undefined });
      else await api.post('/knowledge', { ...body, brandId: form.brandId, sourceCommentId: preset?.sourceCommentId ?? null });
      toast.success(item ? '已更新知識' : approver ? '已新增知識，AI 之後會引用' : '已送出，等待主管審核');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      title={item ? '編輯知識' : approver ? '新增知識' : '提出知識'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving}>
            儲存
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <Alert tone="danger">{error}</Alert>}
        {preset && <Alert>把這次人工處理的答案存成知識，之後遇到相同問題 AI 就能引用。請改成可以公開回覆給所有顧客的寫法，並填上客人會用的關鍵字。</Alert>}
        <div className="form-row">
          <Field label="品牌" required>
            <Select value={form.brandId} disabled={!!item || !!preset} onChange={(e) => set('brandId', Number(e.target.value))}>
              {activeBrands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="分類" required>
            <Select value={form.category} onChange={(e) => set('category', e.target.value as KnowledgeCategory)}>
              {KNOWLEDGE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {KNOWLEDGE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="標題" required>
          <TextInput value={form.title} maxLength={60} onChange={(e) => set('title', e.target.value)} placeholder="例如：耶誕禮盒早鳥優惠" />
        </Field>
        <Field label="內容" required hint="AI 會直接引用這段文字，請寫正確、可以公開回覆給顧客的內容。">
          <Textarea rows={5} maxLength={2000} value={form.content} onChange={(e) => set('content', e.target.value)} />
        </Field>
        <Field label="關鍵字" required hint="用「、」或逗號分隔。留言包含任一關鍵字時，AI 才會找到這則知識。">
          <TextInput value={form.keywords} onChange={(e) => set('keywords', e.target.value)} placeholder="例如：禮盒、早鳥、預購" />
        </Field>
        <div className="form-row">
          <Field label="開始日期（選填）">
            <TextInput type="date" value={form.validFrom} onChange={(e) => set('validFrom', e.target.value)} />
          </Field>
          <Field label="結束日期（選填）" hint="活動、價格等有期限的資訊請填寫，過期後 AI 不會再引用。">
            <TextInput type="date" value={form.validTo} onChange={(e) => set('validTo', e.target.value)} />
          </Field>
        </div>
        {item && (
          <Field label="修改說明（選填）">
            <TextInput value={form.note} maxLength={200} onChange={(e) => set('note', e.target.value)} placeholder="例如：價格調整" />
          </Field>
        )}
      </div>
    </Modal>
  );
}

const CHANGE_LABELS: Record<string, string> = { create: '建立', propose: '提出', update: '修改', approve: '審核通過', reject: '退回', activate: '啟用', deactivate: '停用' };

function HistoryModal({ item, onClose }: { item: KnowledgeItem; onClose: () => void }) {
  const q = useQuery(() => api.get<KnowledgeDetailResponse>(`/knowledge/${item.id}`), [item.id]);
  return (
    <Modal open title={`版本紀錄：${item.title}`} onClose={onClose} size="lg">
      {q.loading && !q.data ? (
        <Loading />
      ) : q.error ? (
        <ErrorMessage error={q.error} />
      ) : (
        <ol className="kb-history">
          {q.data!.revisions.map((r) => (
            <li key={r.id}>
              <div className="row-wrap small">
                <Badge tone="blue">{CHANGE_LABELS[r.changeType] ?? r.changeType}</Badge>
                <span>第 {r.version} 版</span>
                <span className="muted">
                  {r.changedByName ?? '系統'}・{formatDateTime(r.createdAt)}
                </span>
              </div>
              {r.note && <p className="small">說明：{r.note}</p>}
              <p className="small kb-content">
                <strong>{r.snapshot.title}</strong>
                <br />
                {r.snapshot.content}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
