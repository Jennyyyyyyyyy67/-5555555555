// 回覆範本：標準回覆（小編在回覆區一鍵套用）與回覆範例（AI 參考品牌的回覆習慣）。
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useBrandScope } from '../../brand/BrandScope';
import { api, errorMessage } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { useMeta } from '../../lib/meta';
import { formatDateTime, formatRelative } from '../../lib/format';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorMessage, Field, Loading, Modal, PageHeader, Select, Switch, TextInput, Textarea } from '../../components/ui';
import { BrandTag, IconEdit, IconPlus } from '../../components/icons';
import type { CannedReply, CannedReplyInput, ReplyExample, ReplyExampleInput, ReplyExampleListResponse, ReplyExampleStatus } from '../../../../shared/types';
import '../knowledge/knowledge.css';

type Tab = 'canned' | 'examples';

export default function LibraryPage() {
  const [tab, setTab] = useState<Tab>('canned');
  return (
    <>
      <PageHeader
        title="回覆範本"
        description="「標準回覆」是常用的固定回覆，在回覆區可以一鍵套用；「回覆範例」讓 AI 學習品牌的回覆習慣（建議怎麼回、不建議怎麼回）。"
      />
      <div className="kb-tabs" role="tablist" style={{ marginTop: 4 }}>
        <button role="tab" aria-selected={tab === 'canned'} className={`inbox-tab ${tab === 'canned' ? 'active' : ''}`} onClick={() => setTab('canned')}>
          標準回覆
        </button>
        <button role="tab" aria-selected={tab === 'examples'} className={`inbox-tab ${tab === 'examples' ? 'active' : ''}`} onClick={() => setTab('examples')}>
          回覆範例
        </button>
      </div>
      <div style={{ marginTop: 12 }}>{tab === 'canned' ? <CannedTab /> : <ExamplesTab />}</div>
    </>
  );
}

function CategorySelect({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const { meta } = useMeta();
  return (
    <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">不限類型</option>
      {(meta?.categories ?? [])
        .filter((c) => c.isActive || c.id === value)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </Select>
  );
}

function BrandSelect({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const { activeBrands } = useBrandScope();
  return (
    <Select value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
      {activeBrands.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </Select>
  );
}

// ---------------- 標準回覆 ----------------
function CannedTab() {
  const { can, brands } = useAuth();
  const { brandParam } = useBrandScope();
  const toast = useToast();
  const manager = can('approveKnowledge');
  const list = useQuery(() => api.get<CannedReply[]>('/canned-replies', { brand: brandParam }), [brandParam]);
  const [editing, setEditing] = useState<CannedReply | 'new' | null>(null);
  const brandColor = (id: number) => brands.find((b) => b.id === id)?.color ?? '#9aa3af';

  const setActive = async (c: CannedReply, isActive: boolean) => {
    try {
      await api.patch(`/canned-replies/${c.id}`, { isActive });
      toast.success(isActive ? '已啟用' : '已停用，回覆區不會再顯示');
      await list.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted small" style={{ margin: 0 }}>
          可以用 {'{name}'} 代表留言者名稱。標準回覆送出前一樣會經過禁用詞與承諾檢查。
        </p>
        {manager && (
          <Button variant="primary" icon={<IconPlus />} onClick={() => setEditing('new')}>
            新增標準回覆
          </Button>
        )}
      </div>
      {list.error ? (
        <ErrorMessage error={list.error} onRetry={() => void list.reload()} />
      ) : list.loading && !list.data ? (
        <Loading />
      ) : list.data!.length === 0 ? (
        <Card>
          <EmptyState title="還沒有標準回覆" description={manager ? '把常用的回覆（例如請對方私訊、營業時間）存起來，回覆時就能一鍵套用。' : '請主管或管理員新增常用的標準回覆。'} />
        </Card>
      ) : (
        <ul className="kb-list">
          {list.data!.map((c) => (
            <li key={c.id} className={`kb-item ${!c.isActive ? 'off' : ''}`}>
              <div className="row-wrap">
                <strong>{c.title}</strong>
                <Badge tone="blue">{c.categoryName ?? '不限類型'}</Badge>
                {!c.isActive && <Badge>已停用</Badge>}
                <span className="spacer" />
                <BrandTag name={c.brandName} color={brandColor(c.brandId)} />
              </div>
              <p className="kb-content">{c.body}</p>
              <div className="row-wrap small muted">
                <span title={formatDateTime(c.updatedAt)}>
                  {c.createdByName ?? ''} 更新於 {formatRelative(c.updatedAt)}
                </span>
              </div>
              {manager && (
                <div className="row-wrap kb-actions">
                  <Button size="sm" variant="ghost" icon={<IconEdit />} onClick={() => setEditing(c)}>
                    編輯
                  </Button>
                  <Switch checked={c.isActive} onChange={(v) => void setActive(c, v)} label={c.isActive ? '啟用' : '停用'} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <CannedModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />}
    </div>
  );
}

function CannedModal({ item, onClose, onSaved }: { item: CannedReply | null; onClose: () => void; onSaved: () => void }) {
  const { activeBrands, currentBrand } = useBrandScope();
  const toast = useToast();
  const [form, setForm] = useState<CannedReplyInput>({
    brandId: item?.brandId ?? currentBrand?.id ?? activeBrands[0]?.id ?? 0,
    categoryId: item?.categoryId ?? null,
    title: item?.title ?? '',
    body: item?.body ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof CannedReplyInput>(k: K, v: CannedReplyInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      if (item) await api.patch(`/canned-replies/${item.id}`, { categoryId: form.categoryId, title: form.title, body: form.body });
      else await api.post('/canned-replies', form);
      toast.success(item ? '已更新標準回覆' : '已新增標準回覆');
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
      title={item ? '編輯標準回覆' : '新增標準回覆'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            儲存
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="form-row">
          <Field label="品牌" required>
            <BrandSelect value={form.brandId} disabled={!!item} onChange={(v) => set('brandId', v)} />
          </Field>
          <Field label="適用留言類型" hint="回覆這類留言時會排在最前面。">
            <CategorySelect value={form.categoryId} onChange={(v) => set('categoryId', v)} />
          </Field>
        </div>
        <Field label="名稱" required>
          <TextInput value={form.title} maxLength={40} onChange={(e) => set('title', e.target.value)} placeholder="例如：請私訊訂單編號" />
        </Field>
        <Field label="回覆內容" required hint="可用 {name} 代表留言者名稱。">
          <Textarea rows={5} maxLength={2000} value={form.body} onChange={(e) => set('body', e.target.value)} placeholder="例如：{name} 您好，麻煩私訊我們訂單編號，會有專人協助處理喔！" />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------- 回覆範例 ----------------
const EXAMPLE_TABS: Array<{ key: ReplyExampleStatus | ''; label: string; countKey: keyof ReplyExampleListResponse['counts'] }> = [
  { key: 'active', label: 'AI 參考中', countKey: 'active' },
  { key: 'pending', label: '待審核', countKey: 'pending' },
  { key: 'rejected', label: '已退回', countKey: 'rejected' },
  { key: 'inactive', label: '已停用', countKey: 'inactive' },
  { key: '', label: '全部', countKey: 'all' },
];

function ExamplesTab() {
  const { can, brands } = useAuth();
  const { brandParam } = useBrandScope();
  const toast = useToast();
  const approver = can('approveKnowledge');
  const [status, setStatus] = useState<ReplyExampleStatus | ''>('active');
  const list = useQuery(() => api.get<ReplyExampleListResponse>('/reply-examples', { brand: brandParam, status }), [brandParam, status]);
  const [editing, setEditing] = useState<ReplyExample | 'new' | null>(null);
  const [rejecting, setRejecting] = useState<ReplyExample | null>(null);
  const brandColor = (id: number) => brands.find((b) => b.id === id)?.color ?? '#9aa3af';

  const review = async (x: ReplyExample, decision: 'approve' | 'reject', note?: string) => {
    try {
      await api.post(`/reply-examples/${x.id}/review`, { decision, note });
      toast.success(decision === 'approve' ? '已通過，AI 之後會參考這則範例' : '已退回');
      setRejecting(null);
      await list.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const setActive = async (x: ReplyExample, isActive: boolean) => {
    try {
      await api.patch(`/reply-examples/${x.id}`, { isActive });
      toast.success(isActive ? '已啟用' : '已停用，AI 不會再參考');
      await list.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const counts = list.data?.counts;
  return (
    <div className="stack">
      <Alert>
        AI 產生回覆建議時，會參考同品牌、同類型的範例來學習語氣與處理方式；價格等事實仍只會引用知識庫。在收件匣已送出的回覆旁按「收錄為範例」，就能把員工寫得好的回覆收進來
        {approver ? '。' : '（需主管或管理員審核）。'}
      </Alert>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="kb-tabs" role="tablist">
          {EXAMPLE_TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={status === t.key} className={`inbox-tab ${status === t.key ? 'active' : ''}`} onClick={() => setStatus(t.key)}>
              {t.label}
              {counts && <span className="count">{counts[t.countKey]}</span>}
            </button>
          ))}
        </div>
        <Button variant="primary" icon={<IconPlus />} onClick={() => setEditing('new')}>
          {approver ? '新增範例' : '提出範例'}
        </Button>
      </div>
      {list.error ? (
        <ErrorMessage error={list.error} onRetry={() => void list.reload()} />
      ) : list.loading && !list.data ? (
        <Loading />
      ) : list.data!.items.length === 0 ? (
        <Card>
          <EmptyState title="這個條件下沒有回覆範例" description="可以按右上角新增，或從收件匣已送出的回覆收錄。" />
        </Card>
      ) : (
        <ul className="kb-list">
          {list.data!.items.map((x) => (
            <li key={x.id} className={`kb-item ${x.status !== 'active' ? 'off' : ''}`}>
              <div className="row-wrap">
                <Badge tone="blue">{x.categoryName ?? '不限類型'}</Badge>
                {x.scenario && <strong>{x.scenario}</strong>}
                {x.status === 'pending' && <Badge tone="orange">待審核</Badge>}
                {x.status === 'rejected' && <Badge tone="red">已退回</Badge>}
                {x.status === 'inactive' && <Badge>已停用</Badge>}
                {x.source === 'from_reply' && <Badge tone="purple">收錄自實際回覆</Badge>}
                <span className="spacer" />
                <BrandTag name={x.brandName} color={brandColor(x.brandId)} />
              </div>
              <p className="kb-content small">
                <span className="muted">留言：</span>
                {x.sampleComment}
              </p>
              <p className="kb-content">
                <span className="muted small">✅ 建議回覆：</span>
                {x.goodReply}
              </p>
              {x.badReply && (
                <p className="kb-content">
                  <span className="muted small">❌ 不建議：</span>
                  {x.badReply}
                </p>
              )}
              {x.notes && <p className="small muted" style={{ margin: 0 }}>說明：{x.notes}</p>}
              <div className="row-wrap small muted">
                <span>提出：{x.submittedByName ?? '—'}</span>
                {x.approvedByName && x.status === 'active' && <span>審核：{x.approvedByName}</span>}
                <span title={formatDateTime(x.updatedAt)}>更新於 {formatRelative(x.updatedAt)}</span>
              </div>
              {approver && (
                <div className="row-wrap kb-actions">
                  {x.status === 'pending' && (
                    <>
                      <Button size="sm" variant="primary" onClick={() => void review(x, 'approve')}>
                        審核通過
                      </Button>
                      <Button size="sm" onClick={() => setRejecting(x)}>
                        退回
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" icon={<IconEdit />} onClick={() => setEditing(x)}>
                    編輯
                  </Button>
                  {(x.status === 'active' || x.status === 'inactive') && (
                    <Switch checked={x.status === 'active'} onChange={(v) => void setActive(x, v)} label={x.status === 'active' ? '啟用' : '停用'} />
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <ExampleModal item={editing === 'new' ? null : editing} approver={approver} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />}
      <ConfirmDialog
        open={!!rejecting}
        title="退回這則回覆範例？"
        message="退回後 AI 不會參考這則範例。"
        requireReason
        reasonLabel="退回原因"
        reasonPlaceholder="例如：語氣太隨便，不適合這個品牌"
        confirmText="退回"
        onCancel={() => setRejecting(null)}
        onConfirm={(note) => rejecting && void review(rejecting, 'reject', note)}
      />
    </div>
  );
}

function ExampleModal({ item, approver, onClose, onSaved }: { item: ReplyExample | null; approver: boolean; onClose: () => void; onSaved: () => void }) {
  const { activeBrands, currentBrand } = useBrandScope();
  const toast = useToast();
  const [form, setForm] = useState<ReplyExampleInput>({
    brandId: item?.brandId ?? currentBrand?.id ?? activeBrands[0]?.id ?? 0,
    categoryId: item?.categoryId ?? null,
    scenario: item?.scenario ?? '',
    sampleComment: item?.sampleComment ?? '',
    goodReply: item?.goodReply ?? '',
    badReply: item?.badReply ?? '',
    notes: item?.notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ReplyExampleInput>(k: K, v: ReplyExampleInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const { brandId: _brandId, ...rest } = form;
      if (item) await api.patch(`/reply-examples/${item.id}`, rest);
      else await api.post('/reply-examples', form);
      toast.success(item ? '已更新範例' : approver ? '已新增範例，AI 之後會參考' : '已送出，等待主管審核');
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
      title={item ? '編輯回覆範例' : approver ? '新增回覆範例' : '提出回覆範例'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            儲存
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="form-row">
          <Field label="品牌" required>
            <BrandSelect value={form.brandId} disabled={!!item} onChange={(v) => set('brandId', v)} />
          </Field>
          <Field label="哪種留言">
            <CategorySelect value={form.categoryId} onChange={(v) => set('categoryId', v)} />
          </Field>
        </div>
        <Field label="適用情境（選填）">
          <TextInput value={form.scenario} maxLength={100} onChange={(e) => set('scenario', e.target.value)} placeholder="例如：顧客問有沒有空位可以預約" />
        </Field>
        <Field label="範例留言" required>
          <Textarea rows={2} maxLength={1000} value={form.sampleComment} onChange={(e) => set('sampleComment', e.target.value)} />
        </Field>
        <Field label="建議如何回覆" required>
          <Textarea rows={4} maxLength={2000} value={form.goodReply} onChange={(e) => set('goodReply', e.target.value)} />
        </Field>
        <Field label="不建議如何回覆（選填）" hint="寫出常見的錯誤回法，AI 會避免。">
          <Textarea rows={3} maxLength={2000} value={form.badReply} onChange={(e) => set('badReply', e.target.value)} />
        </Field>
        <Field label="說明（選填）">
          <TextInput value={form.notes} maxLength={300} onChange={(e) => set('notes', e.target.value)} placeholder="例如：先回答時間，再邀請私訊預約" />
        </Field>
      </div>
    </Modal>
  );
}
