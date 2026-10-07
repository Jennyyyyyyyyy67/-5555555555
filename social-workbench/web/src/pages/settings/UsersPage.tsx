import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useBrandScope } from '../../brand/BrandScope';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { formatDateTime, formatRelative } from '../../lib/format';
import { useToast } from '../../components/Toast';
import {
  Alert,
  Avatar,
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
  Select,
  TextInput,
} from '../../components/ui';
import { BrandTag, IconEdit, IconKey, IconPlus } from '../../components/icons';
import { PASSWORD_MIN_LENGTH, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES, type Role } from '../../../../shared/constants';
import type { BrandSummary, UserInput, UserPatch, UserRow } from '../../../../shared/types';
import './users.css';

const ROLE_TONE: Record<Role, 'purple' | 'blue' | 'gray'> = { admin: 'purple', supervisor: 'blue', operator: 'gray' };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 產生 12 碼隨機密碼（排除容易看錯的 0/O、1/l/I） */
function generatePassword(length = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}

function passwordError(pw: string): string | undefined {
  if (!pw) return '請輸入密碼';
  if (pw.length < PASSWORD_MIN_LENGTH) return `密碼至少需要 ${PASSWORD_MIN_LENGTH} 個字元，請加長或使用「產生隨機密碼」`;
  if (pw.length > 200) return '密碼最多 200 個字元';
  return undefined;
}

/** 從 API 錯誤取出對應的欄位（後端會在 details.field 標出） */
function errorField(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const field = (err.details as { field?: unknown } | undefined)?.field;
  return typeof field === 'string' ? field : undefined;
}

export default function UsersPage() {
  const { user: me, can, refresh, brands } = useAuth();
  const { brandParam, currentBrand } = useBrandScope();
  const toast = useToast();
  const canManage = can('manageUsers');
  const { data, loading, error, reload } = useQuery(() => api.get<UserRow[]>('/users', { brand: brandParam }), [brandParam]);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | ''>('');
  const [editing, setEditing] = useState<{ user: UserRow | null } | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [toggling, setToggling] = useState<UserRow | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);

  // 管理員：確保品牌清單是最新的（可能有其他管理員剛新增品牌）
  useEffect(() => {
    if (canManage) refresh().catch(() => {});
  }, [canManage, refresh]);

  const brandMap = useMemo(() => new Map(brands.map((b) => [b.id, b])), [brands]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter(
      (u) => (!roleFilter || u.role === roleFilter) && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)),
    );
  }, [data, search, roleFilter]);

  const onSaved = (saved: UserRow, created: boolean) => {
    setEditing(null);
    toast.success(created ? `已新增人員「${saved.name}」` : `已儲存「${saved.name}」的設定`);
    void reload();
    if (saved.id === me?.id) refresh().catch(() => {});
  };

  const doToggle = async () => {
    if (!toggling) return;
    setToggleBusy(true);
    try {
      const patch: UserPatch = { isActive: !toggling.isActive };
      const updated = await api.patch<UserRow>(`/users/${toggling.id}`, patch);
      toast.success(updated.isActive ? `已重新啟用「${updated.name}」` : `已停用「${updated.name}」，其登入中的裝置已登出`);
      setToggling(null);
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setToggleBusy(false);
    }
  };

  const openCreate = () => setEditing({ user: null });
  const filtering = search.trim() !== '' || roleFilter !== '';

  let content;
  if (loading && !data) {
    content = <Loading text="載入人員…" />;
  } else if (error && !data) {
    content = <ErrorMessage error={error} onRetry={() => void reload()} />;
  } else if (!data || data.length === 0) {
    content = (
      <Card>
        <EmptyState
          title={currentBrand ? `目前沒有人員可存取「${currentBrand.name}」` : '目前沒有人員'}
          description={
            canManage
              ? '新增人員並指定角色與授權品牌後，對方即可登入處理留言。'
              : '切換到其他品牌，或聯絡管理員確認人員授權。'
          }
          action={
            canManage ? (
              <Button variant="primary" icon={<IconPlus />} onClick={openCreate}>
                新增人員
              </Button>
            ) : undefined
          }
        />
      </Card>
    );
  } else {
    content = (
      <>
        {error ? <ErrorMessage error={error} onRetry={() => void reload()} /> : null}
        <div className="toolbar">
          <label className="sr-only" htmlFor="users-search">
            搜尋人員
          </label>
          <TextInput
            id="users-search"
            type="search"
            className="users-search"
            placeholder="搜尋姓名或 Email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="sr-only" htmlFor="users-role-filter">
            依角色篩選
          </label>
          <Select
            id="users-role-filter"
            className="users-role-filter"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as Role | '')}
          >
            <option value="">全部角色</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
          <span className="muted small users-toolbar-note">
            {currentBrand ? `可存取「${currentBrand.name}」的人員・` : ''}
            {filtering ? `符合 ${filtered.length} / ${data.length} 位` : `共 ${data.length} 位`}
          </span>
        </div>

        {filtered.length === 0 ? (
          <Card>
            <EmptyState
              title="找不到符合條件的人員"
              description="請調整搜尋文字或角色篩選。"
              action={
                <Button
                  onClick={() => {
                    setSearch('');
                    setRoleFilter('');
                  }}
                >
                  清除篩選
                </Button>
              }
            />
          </Card>
        ) : (
          <Card bodyClassName="">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>人員</th>
                    <th>角色</th>
                    <th>授權品牌</th>
                    <th>狀態</th>
                    <th>最後登入</th>
                    {canManage && <th className="actions-cell">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u) => (
                    <UserTableRow
                      key={u.id}
                      u={u}
                      isSelf={u.id === me?.id}
                      canManage={canManage}
                      brandMap={brandMap}
                      onEdit={() => setEditing({ user: u })}
                      onReset={() => setResetting(u)}
                      onToggle={() => setToggling(u)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="人員與權限"
        description="指定每位人員的角色與可處理的品牌。不同人員可以被授權管理不同品牌。"
        actions={
          canManage ? (
            <Button variant="primary" icon={<IconPlus />} onClick={openCreate}>
              新增人員
            </Button>
          ) : undefined
        }
      />

      {!canManage && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="info">唯讀檢視：只顯示與你負責品牌相關的人員。如需調整權限，請聯絡管理員。</Alert>
        </div>
      )}

      <div className="grid grid-3 users-legend" aria-label="角色說明">
        {ROLES.map((r) => (
          <div key={r} className="card users-legend-item">
            <Badge tone={ROLE_TONE[r]}>{ROLE_LABELS[r]}</Badge>
            <p>{ROLE_DESCRIPTIONS[r]}</p>
          </div>
        ))}
      </div>

      {content}

      {editing && (
        <UserFormModal
          user={editing.user}
          isSelf={!!editing.user && editing.user.id === me?.id}
          brands={brands}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}

      {resetting && (
        <ResetPasswordModal
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            toast.success(`已重設「${resetting.name}」的密碼`);
            setResetting(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!toggling}
        title={toggling?.isActive ? `停用「${toggling.name}」？` : `重新啟用「${toggling?.name ?? ''}」？`}
        message={
          toggling?.isActive
            ? '停用後此人員將無法登入，已登入的裝置會立即登出；處理紀錄會完整保留。'
            : '啟用後此人員可以再次登入，並依目前的角色與授權品牌存取資料。'
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

// ---------------- 表格列 ----------------
function UserTableRow({
  u,
  isSelf,
  canManage,
  brandMap,
  onEdit,
  onReset,
  onToggle,
}: {
  u: UserRow;
  isSelf: boolean;
  canManage: boolean;
  brandMap: Map<number, BrandSummary>;
  onEdit: () => void;
  onReset: () => void;
  onToggle: () => void;
}) {
  return (
    <tr className={u.isActive ? undefined : 'row-muted'}>
      <td>
        <div className="users-person">
          <Avatar name={u.name} />
          <div className="users-person-text">
            <span className="users-person-name">
              {u.name}
              {isSelf && <span className="users-self">（你）</span>}
            </span>
            <span className="muted small truncate">{u.email}</span>
          </div>
        </div>
      </td>
      <td>
        <Badge tone={ROLE_TONE[u.role]}>{ROLE_LABELS[u.role]}</Badge>
      </td>
      <td>
        {u.role === 'admin' ? (
          <Badge>全部品牌</Badge>
        ) : u.brandIds.length === 0 ? (
          <Badge tone="orange" title="此人員登入後看不到任何留言">
            尚未授權品牌
          </Badge>
        ) : (
          <div className="users-brands">
            {u.brandIds.map((id) => {
              const b = brandMap.get(id);
              if (!b) return <span key={id} className="muted small">品牌 #{id}</span>;
              return (
                <span key={id} className={b.isActive ? undefined : 'users-brand-off'} title={b.isActive ? undefined : '此品牌已停用'}>
                  <BrandTag name={b.name} color={b.color} />
                </span>
              );
            })}
          </div>
        )}
      </td>
      <td>
        <Badge tone={u.isActive ? 'green' : 'gray'}>{u.isActive ? '啟用中' : '已停用'}</Badge>
      </td>
      <td className="nowrap">
        {u.lastLoginAt ? (
          <span title={formatDateTime(u.lastLoginAt)}>{formatRelative(u.lastLoginAt)}</span>
        ) : (
          <span className="muted">從未登入</span>
        )}
      </td>
      {canManage && (
        <td className="actions-cell">
          <div className="users-actions">
            <Button size="sm" variant="ghost" icon={<IconEdit />} onClick={onEdit} aria-label={`編輯「${u.name}」`}>
              編輯
            </Button>
            <Button size="sm" variant="ghost" icon={<IconKey />} onClick={onReset} aria-label={`重設「${u.name}」的密碼`}>
              重設密碼
            </Button>
            {isSelf ? (
              <span title="不能停用自己的帳號；如需停用，請由其他管理員操作">
                <Button size="sm" variant="ghost" disabled aria-label="不能停用自己的帳號">
                  停用
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="ghost" onClick={onToggle} aria-label={`${u.isActive ? '停用' : '啟用'}「${u.name}」`}>
                {u.isActive ? '停用' : '啟用'}
              </Button>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}

// ---------------- 新增／編輯人員 ----------------
type FormField = 'name' | 'email' | 'role' | 'brandIds' | 'password';
type FieldErrors = Partial<Record<FormField, string>>;
const FORM_FIELDS: FormField[] = ['name', 'email', 'role', 'brandIds', 'password'];

function UserFormModal({
  user,
  isSelf,
  brands,
  onClose,
  onSaved,
}: {
  user: UserRow | null;
  isSelf: boolean;
  brands: BrandSummary[];
  onClose: () => void;
  onSaved: (user: UserRow, created: boolean) => void;
}) {
  const isCreate = user === null;
  const formId = useId();
  const ids = { name: useId(), email: useId(), password: useId() };
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'operator');
  const [brandIds, setBrandIds] = useState<number[]>(user?.brandIds ?? []);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const clearError = (key: FormField) => {
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const toggleBrand = (id: number, checked: boolean) => {
    setBrandIds((list) => (checked ? [...list, id] : list.filter((b) => b !== id)));
    clearError('brandIds');
  };

  const validate = (): FieldErrors => {
    const e: FieldErrors = {};
    const n = name.trim();
    if (!n) e.name = '請輸入姓名';
    else if (n.length > 30) e.name = '姓名最多 30 個字，請縮短後再儲存';
    if (isCreate) {
      const m = email.trim();
      if (!m) e.email = '請輸入 Email';
      else if (m.length > 120) e.email = 'Email 最多 120 個字元，請確認後再輸入';
      else if (!EMAIL_PATTERN.test(m)) e.email = 'Email 格式不正確，請確認後再輸入（例如 name@company.com）';
      const pe = passwordError(password);
      if (pe) e.password = pe;
    }
    return e;
  };

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    const found = validate();
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length > 0) return;

    // 管理員不需要授權品牌；其餘原樣送出（後端會驗證品牌是否存在），避免清單過期時誤刪既有授權
    const selectedBrands = role === 'admin' ? [] : brandIds;
    setSaving(true);
    try {
      let saved: UserRow;
      if (isCreate) {
        const input: UserInput = { name: name.trim(), email: email.trim().toLowerCase(), role, password, brandIds: selectedBrands };
        saved = await api.post<UserRow>('/users', input);
      } else {
        const patch: UserPatch = { name: name.trim() };
        if (!isSelf) patch.role = role;
        if (role !== 'admin') patch.brandIds = selectedBrands;
        saved = await api.patch<UserRow>(`/users/${user.id}`, patch);
      }
      onSaved(saved, isCreate);
    } catch (err) {
      const field = errorField(err);
      if (field && (FORM_FIELDS as string[]).includes(field)) setErrors({ [field]: errorMessage(err) });
      else setServerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const onGenerate = () => {
    setPassword(generatePassword());
    setShowPassword(true);
    clearError('password');
  };

  return (
    <Modal
      open
      title={isCreate ? '新增人員' : `編輯「${user.name}」`}
      onClose={saving ? () => {} : onClose}
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            {isCreate ? '新增人員' : '儲存'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="users-form">
          {serverError && <Alert tone="danger">{serverError}</Alert>}

          <div className="form-row">
            <Field label="姓名" htmlFor={ids.name} required error={errors.name}>
              <TextInput
                id={ids.name}
                value={name}
                maxLength={30}
                placeholder="例如：王小明"
                autoComplete="off"
                invalid={!!errors.name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearError('name');
                }}
              />
            </Field>
            <Field
              label="Email"
              htmlFor={ids.email}
              required={isCreate}
              error={errors.email}
              hint={isCreate ? '作為登入帳號，建立後不可修改' : 'Email 建立後不可修改'}
            >
              <TextInput
                id={ids.email}
                type="email"
                value={email}
                maxLength={120}
                placeholder="name@company.com"
                autoComplete="off"
                spellCheck={false}
                disabled={!isCreate}
                invalid={!!errors.email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearError('email');
                }}
              />
            </Field>
          </div>

          <Field
            label="角色"
            required
            error={errors.role}
            hint={isSelf ? '不能變更自己的角色；如需調整，請由其他管理員操作' : undefined}
          >
            <fieldset className="users-role-options">
              <legend className="sr-only">角色</legend>
              {ROLES.map((r) => {
                const selected = role === r;
                return (
                  <label
                    key={r}
                    className={`users-role-option ${selected ? 'is-selected' : ''} ${isSelf ? 'is-disabled' : ''}`}
                  >
                    <input
                      type="radio"
                      name={`${formId}-role`}
                      value={r}
                      checked={selected}
                      disabled={isSelf}
                      onChange={() => {
                        setRole(r);
                        clearError('role');
                      }}
                    />
                    <span className="users-role-text">
                      <strong>{ROLE_LABELS[r]}</strong>
                      <span>{ROLE_DESCRIPTIONS[r]}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          </Field>

          {role === 'admin' ? (
            <Alert tone="info">管理員可存取所有品牌，不需要另外勾選授權品牌。</Alert>
          ) : (
            <Field label="授權品牌" error={errors.brandIds}>
              {brands.length === 0 ? (
                <p className="muted small">尚未建立任何品牌，請先到「品牌管理」新增品牌。</p>
              ) : (
                <div className="users-brand-options" role="group" aria-label="授權品牌">
                  {brands.map((b) => (
                    <label key={b.id} className="users-brand-option">
                      <input type="checkbox" checked={brandIds.includes(b.id)} onChange={(e) => toggleBrand(b.id, e.target.checked)} />
                      <span className="brand-dot" style={{ background: b.color }} aria-hidden />
                      <span className="name">{b.name}</span>
                      {!b.isActive && <Badge>已停用</Badge>}
                    </label>
                  ))}
                </div>
              )}
              {brands.length > 0 && brandIds.length === 0 && (
                <Alert tone="warning">尚未勾選品牌時，此人員登入後看不到任何留言。</Alert>
              )}
            </Field>
          )}

          {isCreate && (
            <Field
              label="初始密碼"
              htmlFor={ids.password}
              required
              error={errors.password}
              hint={
                showPassword && password
                  ? '請複製此密碼，並以安全的方式交給本人；建議對方登入後改用自己的密碼。'
                  : `至少 ${PASSWORD_MIN_LENGTH} 個字元`
              }
            >
              <PasswordInput
                id={ids.password}
                value={password}
                visible={showPassword}
                invalid={!!errors.password}
                onChange={(v) => {
                  setPassword(v);
                  clearError('password');
                }}
                onGenerate={onGenerate}
              />
            </Field>
          )}
        </div>
      </form>
    </Modal>
  );
}

// ---------------- 密碼欄位（含產生隨機密碼、複製） ----------------
function PasswordInput({
  id,
  value,
  visible,
  invalid,
  onChange,
  onGenerate,
}: {
  id: string;
  value: string;
  visible: boolean;
  invalid: boolean;
  onChange: (v: string) => void;
  onGenerate: () => void;
}) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('已複製密碼');
    } catch {
      toast.error('無法自動複製，請手動選取密碼後複製');
    }
  };
  return (
    <div className="users-password-row">
      <TextInput
        id={id}
        type={visible ? 'text' : 'password'}
        className={visible ? 'mono' : undefined}
        value={value}
        maxLength={200}
        autoComplete="new-password"
        spellCheck={false}
        invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button variant="ghost" icon={<IconKey />} onClick={onGenerate}>
        產生隨機密碼
      </Button>
      {visible && value && (
        <Button variant="ghost" onClick={() => void copy()}>
          複製
        </Button>
      )}
    </div>
  );
}

// ---------------- 重設密碼 ----------------
function ResetPasswordModal({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: () => void }) {
  const formId = useId();
  const inputId = useId();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    const pe = passwordError(password);
    setError(pe);
    setServerError(null);
    if (pe) return;
    setSaving(true);
    try {
      await api.post(`/users/${user.id}/reset-password`, { password });
      onDone();
    } catch (err) {
      if (errorField(err) === 'password') setError(errorMessage(err));
      else setServerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={`重設「${user.name}」的密碼`}
      onClose={saving ? () => {} : onClose}
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            重設密碼
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="users-form">
          {serverError && <Alert tone="danger">{serverError}</Alert>}
          <Alert tone="warning">重設後，此人員在其他裝置的登入狀態會被登出。</Alert>
          <Field
            label="新密碼"
            htmlFor={inputId}
            required
            error={error}
            hint={
              showPassword && password
                ? '請複製此密碼，並以安全的方式交給本人。'
                : `至少 ${PASSWORD_MIN_LENGTH} 個字元`
            }
          >
            <PasswordInput
              id={inputId}
              value={password}
              visible={showPassword}
              invalid={!!error}
              onChange={(v) => {
                setPassword(v);
                setError(undefined);
              }}
              onGenerate={() => {
                setPassword(generatePassword());
                setShowPassword(true);
                setError(undefined);
              }}
            />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
