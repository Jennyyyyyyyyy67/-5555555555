import { useId, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { formatNumber } from '../../lib/format';
import { useToast } from '../../components/Toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorMessage,
  Field,
  Loading,
  Modal,
  PageHeader,
  TextInput,
  Textarea,
} from '../../components/ui';
import { IconEdit, IconPlus } from '../../components/icons';
import { DEFAULT_NEAR_DUE_MINUTES } from '../../../../shared/constants';
import type { Brand, BrandInput, BrandPatch } from '../../../../shared/types';
import './brands.css';

const PRESET_COLORS = ['#3355d6', '#7b4fe0', '#0e7490', '#15803d', '#b45309', '#d93a3a', '#be185d', '#4b5563'];

const CODE_PATTERN = /^[A-Za-z0-9_-]{2,12}$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

type FieldKey = 'name' | 'code' | 'color' | 'description' | 'nearDueMinutes';
type FieldErrors = Partial<Record<FieldKey, string>>;
const FIELD_KEYS: FieldKey[] = ['name', 'code', 'color', 'description', 'nearDueMinutes'];

interface FormState {
  name: string;
  code: string;
  color: string;
  description: string;
  nearDueMinutes: string;
}

/** 與後端驗證規則一致（server/routes/brands.ts） */
function validate(f: FormState, isCreate: boolean): FieldErrors {
  const e: FieldErrors = {};
  const name = f.name.trim();
  if (!name) e.name = '請輸入品牌名稱';
  else if (name.length > 40) e.name = '品牌名稱最多 40 個字，請縮短後再儲存';

  if (isCreate) {
    const code = f.code.trim();
    if (!code) e.code = '請輸入品牌代碼';
    else if (!CODE_PATTERN.test(code)) e.code = '品牌代碼需為 2–12 個英文字母、數字、底線（_）或連字號（-）';
  }

  if (!COLOR_PATTERN.test(f.color.trim())) e.color = '代表色需為 #RRGGBB 格式（例如 #3355D6），請重新選擇';

  if (f.description.trim().length > 200) e.description = '說明最多 200 個字，請縮短後再儲存';

  const raw = f.nearDueMinutes.trim();
  const n = Number(raw);
  if (!raw) e.nearDueMinutes = '請輸入即將超時門檻';
  else if (!Number.isInteger(n)) e.nearDueMinutes = '即將超時門檻需為整數分鐘';
  else if (n < 1 || n > 240) e.nearDueMinutes = '即將超時門檻需介於 1–240 分鐘';
  return e;
}

export default function BrandsPage() {
  const { refresh } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useQuery(() => api.get<Brand[]>('/brands'), []);
  const [editing, setEditing] = useState<{ brand: Brand | null } | null>(null);
  const [toggling, setToggling] = useState<Brand | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);

  const afterChange = () => {
    void reload();
    // 讓頂部品牌切換器同步更新（新增、改名、停用、啟用）
    refresh().catch(() => {});
  };

  const onSaved = (brand: Brand, created: boolean) => {
    setEditing(null);
    toast.success(created ? `已新增品牌「${brand.name}」` : `已儲存品牌「${brand.name}」`);
    afterChange();
  };

  const doToggle = async () => {
    if (!toggling) return;
    setToggleBusy(true);
    try {
      const patch: BrandPatch = { isActive: !toggling.isActive };
      const updated = await api.patch<Brand>(`/brands/${toggling.id}`, patch);
      toast.success(updated.isActive ? `已重新啟用品牌「${updated.name}」` : `已停用品牌「${updated.name}」`);
      setToggling(null);
      afterChange();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setToggleBusy(false);
    }
  };

  const openCreate = () => setEditing({ brand: null });

  let content;
  if (loading && !data) {
    content = <Loading />;
  } else if (error && !data) {
    content = <ErrorMessage error={error} onRetry={() => void reload()} />;
  } else if (!data || data.length === 0) {
    content = (
      <Card>
        <EmptyState
          title="尚未建立任何品牌"
          description="新增第一個品牌後，即可為它連結社群帳號、授權人員並設定 AI 回覆風格。"
          action={
            <Button variant="primary" icon={<IconPlus />} onClick={openCreate}>
              新增品牌
            </Button>
          }
        />
      </Card>
    );
  } else {
    content = (
      <div className="stack">
        {error ? <ErrorMessage error={error} onRetry={() => void reload()} /> : null}
        <Card bodyClassName="">
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th>品牌</th>
                  <th>說明</th>
                  <th className="num">社群帳號</th>
                  <th className="num">授權人員</th>
                  <th className="num">留言數</th>
                  <th>即將超時門檻</th>
                  <th>狀態</th>
                  <th className="actions-cell">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.map((b) => (
                  <tr key={b.id} className={b.isActive ? undefined : 'row-muted'}>
                    <td className="card-title">
                      <div className="brands-name-cell">
                        <span className="brand-dot" style={{ background: b.color }} aria-hidden />
                        <span className="brands-name">{b.name}</span>
                        <span className="mono muted">{b.code}</span>
                      </div>
                    </td>
                    <td data-label="說明">
                      <div className="truncate brands-desc" title={b.description || undefined}>
                        {b.description || <span className="muted">—</span>}
                      </div>
                    </td>
                    <td className="num" data-label="社群帳號">{formatNumber(b.accountCount ?? 0)}</td>
                    <td className="num" data-label="授權人員">{formatNumber(b.userCount ?? 0)}</td>
                    <td className="num" data-label="留言數">{formatNumber(b.commentCount ?? 0)}</td>
                    <td className="nowrap" data-label="即將超時門檻">剩 {b.nearDueMinutes} 分鐘</td>
                    <td data-label="狀態">
                      <Badge tone={b.isActive ? 'green' : 'gray'}>{b.isActive ? '啟用中' : '已停用'}</Badge>
                    </td>
                    <td className="actions-cell">
                      <span className="row-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconEdit />}
                        onClick={() => setEditing({ brand: b })}
                        aria-label={`編輯品牌「${b.name}」`}
                      >
                        編輯
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setToggling(b)}
                        aria-label={`${b.isActive ? '停用' : '啟用'}品牌「${b.name}」`}
                      >
                        {b.isActive ? '停用' : '啟用'}
                      </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="品牌管理"
        description="每個品牌各自擁有社群帳號、AI 回覆風格、知識庫、自動化規則與數據看板，彼此資料完全分開。品牌只能停用、不能刪除，以保留完整的歷史紀錄。"
        actions={
          <Button variant="primary" icon={<IconPlus />} onClick={openCreate}>
            新增品牌
          </Button>
        }
      />
      {content}

      {editing && <BrandFormModal brand={editing.brand} onClose={() => setEditing(null)} onSaved={onSaved} />}

      <ConfirmDialog
        open={!!toggling}
        title={toggling?.isActive ? `停用品牌「${toggling.name}」？` : `重新啟用品牌「${toggling?.name ?? ''}」？`}
        message={
          toggling?.isActive ? (
            <div className="stack">
              <p>停用後，主管與操作人員將看不到此品牌與其留言；資料會完整保留，管理員可隨時重新啟用。</p>
              {(toggling.userCount ?? 0) > 0 && (
                <p className="muted small">目前有 {formatNumber(toggling.userCount)} 位人員被授權此品牌。</p>
              )}
            </div>
          ) : (
            <p>啟用後，已授權此品牌的主管與操作人員會再次看到此品牌與其留言。</p>
          )
        }
        confirmText={toggling?.isActive ? '停用' : '啟用'}
        danger={!!toggling?.isActive}
        busy={toggleBusy}
        onConfirm={() => void doToggle()}
        onCancel={() => setToggling(null)}
      />
    </>
  );
}

function BrandFormModal({
  brand,
  onClose,
  onSaved,
}: {
  brand: Brand | null;
  onClose: () => void;
  onSaved: (brand: Brand, created: boolean) => void;
}) {
  const isCreate = brand === null;
  const formId = useId();
  const ids = { name: useId(), code: useId(), color: useId(), description: useId(), nearDue: useId() };
  const [form, setForm] = useState<FormState>(() => ({
    name: brand?.name ?? '',
    code: brand?.code ?? '',
    color: (brand?.color ?? PRESET_COLORS[0]).toLowerCase(),
    description: brand?.description ?? '',
    nearDueMinutes: String(brand?.nearDueMinutes ?? DEFAULT_NEAR_DUE_MINUTES),
  }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const found = validate(form, isCreate);
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length > 0) return;

    const common = {
      name: form.name.trim(),
      color: form.color.trim().toLowerCase(),
      description: form.description.trim(),
      nearDueMinutes: Number(form.nearDueMinutes.trim()),
    };
    setSaving(true);
    try {
      let saved: Brand;
      if (isCreate) {
        const input: BrandInput = { ...common, code: form.code.trim().toUpperCase() };
        saved = await api.post<Brand>('/brands', input);
      } else {
        const patch: BrandPatch = common;
        saved = await api.patch<Brand>(`/brands/${brand.id}`, patch);
      }
      onSaved(saved, isCreate);
    } catch (err) {
      const field = err instanceof ApiError ? (err.details as { field?: unknown } | undefined)?.field : undefined;
      if (typeof field === 'string' && (FIELD_KEYS as string[]).includes(field)) {
        setErrors({ [field]: errorMessage(err) });
      } else {
        setServerError(errorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={isCreate ? '新增品牌' : `編輯品牌「${brand.name}」`}
      onClose={saving ? () => {} : onClose}
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            {isCreate ? '新增品牌' : '儲存'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="brands-form">
          {serverError && <Alert tone="danger">{serverError}</Alert>}

          <div className="form-row">
            <Field label="品牌名稱" htmlFor={ids.name} required error={errors.name}>
              <TextInput
                id={ids.name}
                value={form.name}
                maxLength={40}
                placeholder="例如：日日咖啡"
                invalid={!!errors.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
            <Field
              label="品牌代碼"
              htmlFor={ids.code}
              required={isCreate}
              error={errors.code}
              hint={
                isCreate
                  ? '2–12 個英文字母、數字、底線或連字號。建立後不可修改，用於系統識別'
                  : '建立後不可修改，用於系統識別'
              }
            >
              <TextInput
                id={ids.code}
                className="mono brands-code-input"
                value={form.code}
                maxLength={12}
                placeholder="例如：DAILY"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={!isCreate}
                invalid={!!errors.code}
                onChange={(e) => set('code', e.target.value)}
              />
            </Field>
          </div>

          <Field label="代表色" htmlFor={ids.color} required error={errors.color} hint="用於品牌標籤、篩選與圖表，方便一眼分辨品牌">
            <div className="brands-color-picker">
              <input
                id={ids.color}
                type="color"
                className="brands-color-input"
                value={COLOR_PATTERN.test(form.color) ? form.color : PRESET_COLORS[0]}
                onChange={(e) => set('color', e.target.value.toLowerCase())}
              />
              <div className="brands-swatches" role="group" aria-label="常用代表色">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="brands-swatch"
                    style={{ background: c }}
                    aria-label={`使用代表色 ${c.toUpperCase()}`}
                    aria-pressed={form.color.toLowerCase() === c}
                    onClick={() => set('color', c)}
                  />
                ))}
              </div>
              <span className="brands-color-value">{form.color.toUpperCase()}</span>
            </div>
          </Field>

          <Field label="說明" htmlFor={ids.description} error={errors.description} hint={`${form.description.trim().length} / 200 字`}>
            <Textarea
              id={ids.description}
              value={form.description}
              rows={3}
              maxLength={200}
              placeholder="簡短說明品牌定位或負責範圍，方便團隊辨識"
              invalid={!!errors.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>

          <Field
            label="即將超時門檻（分鐘）"
            htmlFor={ids.nearDue}
            required
            error={errors.nearDueMinutes}
            hint="留言剩餘回覆時間少於此值時，在收件匣標示為『即將超時』"
          >
            <TextInput
              id={ids.nearDue}
              type="number"
              inputMode="numeric"
              min={1}
              max={240}
              step={1}
              value={form.nearDueMinutes}
              invalid={!!errors.nearDueMinutes}
              onChange={(e) => set('nearDueMinutes', e.target.value)}
              style={{ maxWidth: 160 }}
            />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
