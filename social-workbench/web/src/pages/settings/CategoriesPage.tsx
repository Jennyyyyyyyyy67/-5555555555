// 設定：留言類型（全系統共用）與各品牌的回覆時效
import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useBrandScope } from '../../brand/BrandScope';
import { api, errorMessage } from '../../lib/api';
import { useMeta } from '../../lib/meta';
import { useQuery } from '../../lib/useQuery';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card, ErrorMessage, Field, Loading, Modal, PageHeader, PRIORITY_TONE, Select, Switch, TextInput, Textarea, Checkbox } from '../../components/ui';
import { IconEdit, IconPlus } from '../../components/icons';
import { PRIORITIES, PRIORITY_LABELS, type Priority } from '../../../../shared/constants';
import type { BrandCategorySetting, CategoryInput, CategoryMeta } from '../../../../shared/types';

export default function CategoriesPage() {
  const { can } = useAuth();
  const editable = can('manageSettings');
  const editGlobal = can('manageSystem');
  return (
    <>
      <PageHeader
        title="留言類型與回覆時效"
        description="回覆時效＝從對方留言起算，必須在幾分鐘內第一次回覆。即將超時的提醒門檻在「品牌管理」設定。"
      />
      {!editable && <Alert>你可以檢視設定；只有管理員可以修改。</Alert>}
      {editable && !editGlobal && <Alert>你可以調整自己品牌的回覆時效；留言類型由系統管理員統一維護。</Alert>}
      <div className="stack" style={{ gap: 20, marginTop: editable ? 0 : 12 }}>
        <BrandSla editable={editable} />
        <CategoryList editable={editGlobal} />
      </div>
    </>
  );
}

// ---------- 各品牌時效 ----------
function BrandSla({ editable }: { editable: boolean }) {
  const toast = useToast();
  const { activeBrands, selected } = useBrandScope();
  const [brandId, setBrandId] = useState<number>(() => (selected === 'all' ? activeBrands[0]?.id : selected) ?? 0);
  const q = useQuery(() => (brandId ? api.get<BrandCategorySetting[]>(`/brands/${brandId}/category-settings`) : Promise.resolve([])), [brandId]);
  const [rows, setRows] = useState<BrandCategorySetting[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => setRows(q.data ?? []), [q.data]);

  const dirty = rows.filter((r) => {
    const o = q.data?.find((x) => x.categoryId === r.categoryId);
    return o && (o.slaEnabled !== r.slaEnabled || o.slaMinutes !== r.slaMinutes);
  });
  const invalid = rows.some((r) => r.slaEnabled && (!r.slaMinutes || r.slaMinutes < 1));
  const update = (id: number, patch: Partial<BrandCategorySetting>) => setRows((list) => list.map((r) => (r.categoryId === id ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put<BrandCategorySetting[]>(`/brands/${brandId}/category-settings`, {
        items: dirty.map((r) => ({ categoryId: r.categoryId, slaEnabled: r.slaEnabled, slaMinutes: r.slaMinutes })),
      });
      setRows(res);
      await q.reload();
      toast.success('已儲存回覆時效（只影響之後進來的留言）');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="各品牌回覆時效"
      actions={
        <Select value={brandId} onChange={(e) => setBrandId(Number(e.target.value))} aria-label="選擇品牌" style={{ width: 'auto' }}>
          {activeBrands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      }
      bodyClassName=""
    >
      {q.error ? (
        <div className="card-body">
          <ErrorMessage error={q.error} onRetry={() => void q.reload()} />
        </div>
      ) : q.loading && !q.data ? (
        <Loading />
      ) : (
        <>
          <table className="table table-cards">
            <thead>
              <tr>
                <th>留言類型</th>
                <th>計算時效</th>
                <th>幾分鐘內要回覆</th>
                <th>系統預設</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((r) => r.categoryActive)
                .map((r) => (
                  <tr key={r.categoryId}>
                    <td data-label="留言類型">
                      <strong>{r.name}</strong>
                    </td>
                    <td data-label="計算時效">
                      <Switch
                        checked={r.slaEnabled}
                        disabled={!editable}
                        onChange={(v) => update(r.categoryId, { slaEnabled: v, slaMinutes: v ? (r.slaMinutes ?? r.defaultSlaMinutes ?? 60) : r.slaMinutes })}
                        label={r.slaEnabled ? '計時' : '不計時'}
                      />
                    </td>
                    <td data-label="幾分鐘內要回覆">
                      {r.slaEnabled ? (
                        <span className="row">
                          <TextInput
                            type="number"
                            min={1}
                            max={10080}
                            value={r.slaMinutes ?? ''}
                            disabled={!editable}
                            onChange={(e) => update(r.categoryId, { slaMinutes: e.target.value ? Math.floor(Number(e.target.value)) : null })}
                            style={{ width: 90 }}
                            aria-label={`${r.name} 時效分鐘`}
                            invalid={!r.slaMinutes || r.slaMinutes < 1}
                          />
                          <span className="muted small">分鐘</span>
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td data-label="系統預設" className="muted">
                      {r.defaultSlaMinutes ? `${r.defaultSlaMinutes} 分鐘` : '不計時'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {editable && (
            <div className="card-body row" style={{ justifyContent: 'flex-end' }}>
              {invalid && <span className="small" style={{ color: 'var(--danger-text)' }}>開啟時效的類型需填寫 1 分鐘以上</span>}
              <Button onClick={() => setRows(q.data ?? [])} disabled={dirty.length === 0 || saving}>
                還原
              </Button>
              <Button variant="primary" onClick={() => void save()} disabled={dirty.length === 0 || invalid} loading={saving}>
                儲存變更{dirty.length ? `（${dirty.length}）` : ''}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ---------- 類型清單 ----------
interface FormState {
  name: string;
  description: string;
  slaEnabled: boolean;
  sla: string;
  defaultPriority: Priority;
  needsReply: boolean;
}

function CategoryList({ editable }: { editable: boolean }) {
  const toast = useToast();
  const { meta, reload } = useMeta();
  const [editing, setEditing] = useState<CategoryMeta | 'new' | null>(null);
  const [form, setForm] = useState<FormState>({ name: '', description: '', slaEnabled: true, sla: '60', defaultPriority: 'medium', needsReply: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openEdit = (c: CategoryMeta | 'new') => {
    setError(null);
    setEditing(c);
    setForm(
      c === 'new'
        ? { name: '', description: '', slaEnabled: true, sla: '60', defaultPriority: 'medium', needsReply: true }
        : { name: c.name, description: c.description, slaEnabled: c.slaMinutes !== null, sla: String(c.slaMinutes ?? 60), defaultPriority: c.defaultPriority, needsReply: c.needsReply },
    );
  };

  const submit = async () => {
    const minutes = Math.floor(Number(form.sla));
    if (!form.name.trim()) return setError('請輸入類型名稱');
    if (form.slaEnabled && !(minutes >= 1)) return setError('時效至少 1 分鐘');
    const body: CategoryInput = {
      name: form.name.trim(),
      description: form.description.trim(),
      defaultSlaMinutes: form.slaEnabled ? minutes : null,
      defaultPriority: form.defaultPriority,
      needsReply: form.needsReply,
    };
    setSaving(true);
    try {
      if (editing === 'new') await api.post('/categories', body);
      else if (editing) await api.patch(`/categories/${editing.id}`, body);
      await reload();
      toast.success(editing === 'new' ? '已新增留言類型，所有品牌都會套用預設時效' : '已更新留言類型');
      setEditing(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (c: CategoryMeta, active: boolean) => {
    try {
      await api.patch(`/categories/${c.id}`, { isActive: active });
      await reload();
      toast.success(active ? `已啟用「${c.name}」` : `已停用「${c.name}」，AI 不會再分到這個類型`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const list = meta?.categories ?? [];
  return (
    <Card
      title="留言類型（所有品牌共用）"
      actions={
        editable && (
          <Button size="sm" variant="primary" icon={<IconPlus />} onClick={() => openEdit('new')}>
            新增類型
          </Button>
        )
      }
      bodyClassName=""
    >
      <table className="table table-cards">
        <thead>
          <tr>
            <th>名稱</th>
            <th>預設時效</th>
            <th>預設優先級</th>
            <th>需要回覆</th>
            <th>啟用</th>
            {editable && <th />}
          </tr>
        </thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.id} className={c.isActive ? '' : 'row-muted'}>
              <td data-label="名稱">
                <strong>{c.name}</strong>
                {c.description && <div className="muted small">{c.description}</div>}
              </td>
              <td data-label="預設時效">{c.slaMinutes ? `${c.slaMinutes} 分鐘` : '不計時'}</td>
              <td data-label="預設優先級">
                <Badge tone={PRIORITY_TONE[c.defaultPriority]}>{PRIORITY_LABELS[c.defaultPriority]}</Badge>
              </td>
              <td data-label="需要回覆">{c.needsReply ? '是' : '否'}</td>
              <td data-label="啟用">
                <Switch checked={c.isActive} disabled={!editable || c.key === 'other'} onChange={(v) => void toggleActive(c, v)} label={c.isActive ? '啟用' : '停用'} />
              </td>
              {editable && (
                <td className="row-actions">
                  <Button size="sm" variant="ghost" icon={<IconEdit />} onClick={() => openEdit(c)}>
                    編輯
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <Modal
        open={!!editing}
        title={editing === 'new' ? '新增留言類型' : '編輯留言類型'}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>取消</Button>
            <Button variant="primary" onClick={() => void submit()} loading={saving}>
              儲存
            </Button>
          </>
        }
      >
        <div className="stack">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="類型名稱" required>
            <TextInput value={form.name} maxLength={20} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：門市服務" />
          </Field>
          <Field label="說明">
            <Textarea rows={2} maxLength={100} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="給同事看的判斷說明" />
          </Field>
          <Field label="預設回覆時效" hint="新增類型時會套用到所有品牌，之後可在上方依品牌調整。">
            <div className="row-wrap">
              <Switch checked={form.slaEnabled} onChange={(v) => setForm({ ...form, slaEnabled: v })} label={form.slaEnabled ? '計時' : '不計時'} />
              {form.slaEnabled && (
                <span className="row">
                  <TextInput type="number" min={1} value={form.sla} onChange={(e) => setForm({ ...form, sla: e.target.value })} style={{ width: 100 }} aria-label="分鐘" />
                  <span className="muted small">分鐘</span>
                </span>
              )}
            </div>
          </Field>
          <Field label="預設優先級">
            <Select value={form.defaultPriority} onChange={(e) => setForm({ ...form, defaultPriority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Checkbox label="這類留言需要回覆" checked={form.needsReply} onChange={(v) => setForm({ ...form, needsReply: v })} />
        </div>
      </Modal>
    </Card>
  );
}
