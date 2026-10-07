import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useBrandScope } from '../../brand/BrandScope';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { useMeta } from '../../lib/meta';
import { formatDateTime, formatNumber, formatRelative } from '../../lib/format';
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
  Select,
  TextInput,
  type BadgeTone,
} from '../../components/ui';
import { BrandTag, IconEdit, IconPlus, IconRefresh, PlatformIcon } from '../../components/icons';
import {
  ACCOUNT_STATUS_LABELS,
  CAPABILITIES,
  CAPABILITY_LABELS,
  CONTENT_TYPE_LABELS,
  type AccountStatus,
} from '../../../../shared/constants';
import type {
  CreateSocialAccountResponse,
  PlatformCapabilities,
  SocialAccount,
  TestConnectionResponse,
} from '../../../../shared/types';
import './accounts.css';

const STATUS_TONE: Record<AccountStatus, BadgeTone> = { connected: 'green', disconnected: 'gray', error: 'red' };

const FALLBACK_BRAND_COLOR = '#9aa3af';

function CapabilityChips({ capabilities }: { capabilities: PlatformCapabilities | undefined }) {
  if (!capabilities) return <span className="muted small">—</span>;
  return (
    <span className="acc-chips">
      {CAPABILITIES.map((key) =>
        capabilities[key] ? (
          <Badge key={key} tone="teal">
            {CAPABILITY_LABELS[key]}
          </Badge>
        ) : (
          <span key={key} className="badge acc-chip-off" title="此平台 API 不支援">
            {CAPABILITY_LABELS[key]}
            <span className="sr-only">（此平台 API 不支援）</span>
          </span>
        ),
      )}
    </span>
  );
}

export default function AccountsPage() {
  const { can, brands } = useAuth();
  const { brandParam } = useBrandScope();
  const { meta, platform: platformOf, platformLabel, accountTypeLabel } = useMeta();
  const toast = useToast();
  const canManage = can('manageAccounts');

  const [platformFilter, setPlatformFilter] = useState('');
  const { data, loading, error, reload, setData } = useQuery(
    () => api.get<SocialAccount[]>('/accounts', { brand: brandParam, platform: platformFilter }),
    [brandParam, platformFilter],
  );

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<SocialAccount | null>(null);
  const [deactivating, setDeactivating] = useState<SocialAccount | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [testingIds, setTestingIds] = useState<ReadonlySet<number>>(new Set());

  const brandOf = (id: number) => brands.find((b) => b.id === id);
  const capabilitiesOf = (a: SocialAccount) => platformOf(a.platform)?.accountTypes.find((t) => t.key === a.accountType)?.capabilities;
  const replaceRow = (acc: SocialAccount) => setData((prev) => (prev ?? []).map((x) => (x.id === acc.id ? acc : x)));

  const testConnection = async (a: SocialAccount) => {
    setTestingIds((s) => new Set(s).add(a.id));
    try {
      const r = await api.post<TestConnectionResponse>(`/accounts/${a.id}/test`);
      replaceRow(r.account);
      if (r.ok) toast.success(`${r.account.name}：${r.message}`);
      else toast.error(`${r.account.name}：${r.message}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTestingIds((s) => {
        const next = new Set(s);
        next.delete(a.id);
        return next;
      });
    }
  };

  const setActive = async (a: SocialAccount, isActive: boolean) => {
    setTogglingId(a.id);
    try {
      const updated = await api.patch<SocialAccount>(`/accounts/${a.id}`, { isActive });
      replaceRow(updated);
      toast.success(isActive ? `已啟用「${updated.name}」` : `已停用「${updated.name}」，不再接收此帳號的新留言`);
      setDeactivating(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTogglingId(null);
    }
  };

  const accounts = data ?? [];
  const emptyTitle = platformFilter
    ? `沒有${platformLabel(platformFilter)}的社群帳號`
    : brandParam === 'all'
      ? '目前還沒有綁定任何社群帳號'
      : '這個品牌還沒有綁定任何社群帳號';

  return (
    <>
      <PageHeader
        title="社群帳號"
        description="各品牌綁定的社群平台帳號。目前全部透過「模擬連線」運作；日後串接真實平台 API 時，只需替換該平台的 adapter，其他功能不受影響。"
        actions={
          canManage && (
            <Button variant="primary" icon={<IconPlus />} onClick={() => setAddOpen(true)}>
              新增社群帳號
            </Button>
          )
        }
      />

      <div className="acc-page">
        {!canManage && <Alert tone="info">唯讀檢視：如需新增或修改社群帳號，請聯絡管理員。</Alert>}

        <div className="toolbar">
          <Select aria-label="篩選平台" value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)}>
            <option value="">全部平台</option>
            {meta?.platforms.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
          {data && <span className="muted small">共 {accounts.length} 個帳號</span>}
        </div>

        {error ? (
          <ErrorMessage error={error} onRetry={reload} />
        ) : loading && !data ? (
          <Loading />
        ) : accounts.length === 0 ? (
          <Card>
            <EmptyState
              title={emptyTitle}
              description={
                platformFilter
                  ? '可以切換其他平台，或顯示全部平台。'
                  : canManage
                    ? '按「新增社群帳號」綁定品牌在各社群平台的帳號。'
                    : '如需綁定社群帳號，請聯絡管理員。'
              }
              action={
                platformFilter ? (
                  <Button onClick={() => setPlatformFilter('')}>顯示全部平台</Button>
                ) : canManage ? (
                  <Button variant="primary" icon={<IconPlus />} onClick={() => setAddOpen(true)}>
                    新增社群帳號
                  </Button>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <Card bodyClassName="">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>平台</th>
                    <th>帳號名稱</th>
                    <th>品牌</th>
                    <th>支援動作</th>
                    <th>連線狀態</th>
                    <th className="num">貼文／留言</th>
                    {canManage && <th className="actions-cell">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => {
                    const brand = brandOf(a.brandId);
                    const testing = testingIds.has(a.id);
                    return (
                      <tr key={a.id} className={a.isActive ? undefined : 'row-muted'}>
                        <td>
                          <span className="acc-type">
                            <PlatformIcon platform={a.platform} />
                            {accountTypeLabel(a.accountType)}
                          </span>
                        </td>
                        <td>
                          <span className="acc-name">
                            <span className="row" style={{ gap: 6 }}>
                              <strong>{a.name}</strong>
                              {!a.isActive && <Badge>已停用</Badge>}
                            </span>
                            {a.handle && <span className="muted small">{a.handle}</span>}
                          </span>
                        </td>
                        <td>
                          <BrandTag name={a.brandName} color={brand?.color ?? FALLBACK_BRAND_COLOR} />
                          {brand && !brand.isActive && <div className="muted small">品牌已停用</div>}
                        </td>
                        <td>
                          <CapabilityChips capabilities={capabilitiesOf(a)} />
                        </td>
                        <td>
                          <span className="acc-status">
                            <Badge tone={STATUS_TONE[a.status]}>{ACCOUNT_STATUS_LABELS[a.status] ?? a.status}</Badge>
                            <span className="muted small" title={a.lastCheckedAt ? formatDateTime(a.lastCheckedAt) : undefined}>
                              最後檢查：{a.lastCheckedAt ? formatRelative(a.lastCheckedAt) : '尚未檢查'}
                            </span>
                          </span>
                        </td>
                        <td className="num nowrap">
                          {formatNumber(a.postCount)}／{formatNumber(a.commentCount)}
                        </td>
                        {canManage && (
                          <td className="actions-cell">
                            <span className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                              <Button
                                size="sm"
                                icon={<IconRefresh />}
                                loading={testing}
                                onClick={() => void testConnection(a)}
                              >
                                {testing ? '測試中…' : '測試連線'}
                              </Button>
                              <Button size="sm" variant="ghost" icon={<IconEdit />} onClick={() => setEditing(a)}>
                                編輯
                              </Button>
                              {a.isActive ? (
                                <Button size="sm" variant="ghost" onClick={() => setDeactivating(a)}>
                                  停用
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  loading={togglingId === a.id}
                                  onClick={() => void setActive(a, true)}
                                >
                                  啟用
                                </Button>
                              )}
                            </span>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <Card title="平台串接狀態">
          <p className="muted small" style={{ marginBottom: 12 }}>
            每個平台各由一個 adapter 負責串接，日後接上真實 API 時只要替換該平台的 adapter，帳號、留言與操作紀錄等其他功能都不受影響。
          </p>
          {meta ? (
            <ul className="acc-platforms">
              {meta.platforms.map((p) => (
                <li key={p.key}>
                  <span className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <span className="row">
                      <PlatformIcon platform={p.key} />
                      <strong>{p.label}</strong>
                    </span>
                    {p.isMock ? <Badge tone="orange">模擬 adapter</Badge> : <Badge tone="green">已串接 API</Badge>}
                  </span>
                  <span className="muted small">{p.accountTypes.map((t) => t.label).join('、')}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Loading />
          )}
        </Card>
      </div>

      {addOpen && (
        <AddAccountModal
          onClose={() => setAddOpen(false)}
          onCreated={(created) => {
            setAddOpen(false);
            const text = `已新增「${created.name}」。${created.connection.message}`;
            if (created.connection.ok) toast.success(text);
            else toast.error(`${text}。請確認平台帳號 ID 或授權後再按「測試連線」。`);
            void reload();
          }}
        />
      )}

      {editing && (
        <EditAccountModal
          account={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setEditing(null);
            replaceRow(updated);
            toast.success(`已儲存「${updated.name}」`);
          }}
        />
      )}

      <ConfirmDialog
        open={!!deactivating}
        title={deactivating ? `停用「${deactivating.name}」？` : '停用社群帳號'}
        message="停用後不再從此帳號接收新留言，既有留言與紀錄會保留。之後可以隨時重新啟用。"
        confirmText="停用"
        danger
        busy={!!deactivating && togglingId === deactivating.id}
        onConfirm={() => deactivating && void setActive(deactivating, false)}
        onCancel={() => setDeactivating(null)}
      />
    </>
  );
}

// ---------------- 新增社群帳號 ----------------
type AddField = 'brandId' | 'platform' | 'accountType' | 'name' | 'handle' | 'externalId';
const ADD_FIELDS: AddField[] = ['brandId', 'platform', 'accountType', 'name', 'handle', 'externalId'];

function AddAccountModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (a: CreateSocialAccountResponse) => void;
}) {
  const { activeBrands, currentBrand } = useBrandScope();
  const { meta, platform: platformOf } = useMeta();
  const platforms = meta?.platforms ?? [];

  const [brandId, setBrandId] = useState<string>(() => String(currentBrand?.id ?? activeBrands[0]?.id ?? ''));
  const [platform, setPlatform] = useState<string>(platforms[0]?.key ?? '');
  const [accountType, setAccountType] = useState<string>(platforms[0]?.accountTypes[0]?.key ?? '');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [externalId, setExternalId] = useState('');
  const [errors, setErrors] = useState<Partial<Record<AddField, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 中繼資料晚於對話框載入時，補上預設平台
  useEffect(() => {
    if (!platform && platforms.length > 0) {
      setPlatform(platforms[0].key);
      setAccountType(platforms[0].accountTypes[0]?.key ?? '');
    }
  }, [platform, platforms]);

  const platformMeta = platformOf(platform);
  const typeDef = platformMeta?.accountTypes.find((t) => t.key === accountType);

  const changePlatform = (key: string) => {
    setPlatform(key);
    setAccountType(platformOf(key)?.accountTypes[0]?.key ?? '');
    setErrors((e) => ({ ...e, platform: undefined, accountType: undefined }));
  };

  const validate = (): boolean => {
    const next: Partial<Record<AddField, string>> = {};
    if (!brandId) next.brandId = '請選擇品牌';
    if (!platform) next.platform = '請選擇平台';
    if (!accountType) next.accountType = '請選擇帳號類型';
    if (!name.trim()) next.name = '請輸入帳號名稱';
    else if (name.trim().length > 60) next.name = '帳號名稱最多 60 個字';
    if (handle.trim().length > 60) next.handle = '帳號代稱最多 60 個字';
    if (!externalId.trim()) next.externalId = '請輸入平台帳號 ID';
    else if (externalId.trim().length > 120) next.externalId = '平台帳號 ID 最多 120 個字';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const created = await api.post<CreateSocialAccountResponse>('/accounts', {
        brandId: Number(brandId),
        platform,
        accountType,
        name: name.trim(),
        handle: handle.trim() || undefined,
        externalId: externalId.trim(),
      });
      onCreated(created);
    } catch (err) {
      // 欄位格式錯誤時後端會在 details.field 標出欄位，顯示在該欄位下；其他錯誤顯示在對話框上方
      const field = err instanceof ApiError ? (err.details as { field?: unknown } | undefined)?.field : undefined;
      if (typeof field === 'string' && (ADD_FIELDS as string[]).includes(field)) {
        setErrors({ [field]: errorMessage(err) });
      } else {
        setServerError(errorMessage(err));
      }
      setBusy(false);
    }
  };

  const noBrands = activeBrands.length === 0;

  return (
    <Modal
      open
      title="新增社群帳號"
      onClose={busy ? () => {} : onClose}
      closeOnBackdrop={false}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" form="acc-add-form" variant="primary" loading={busy} disabled={noBrands || !meta}>
            {busy ? '新增並測試連線中…' : '新增'}
          </Button>
        </>
      }
    >
      <form id="acc-add-form" onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="stack acc-form">
          {noBrands && <Alert tone="warning">目前沒有啟用中的品牌，請先到品牌管理新增或啟用品牌，再綁定社群帳號。</Alert>}
          {serverError && <Alert tone="danger">{serverError}</Alert>}

          <div className="form-row">
            <Field label="品牌" htmlFor="acc-brand" required error={errors.brandId}>
              <Select id="acc-brand" value={brandId} invalid={!!errors.brandId} onChange={(e) => setBrandId(e.target.value)}>
                {activeBrands.length === 0 && <option value="">（沒有可用的品牌）</option>}
                {activeBrands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={
                <span className="row" style={{ gap: 6, display: 'inline-flex' }}>
                  平台
                  {platformMeta?.isMock && <Badge tone="orange">模擬</Badge>}
                </span>
              }
              htmlFor="acc-platform"
              required
              error={errors.platform}
            >
              <Select id="acc-platform" value={platform} invalid={!!errors.platform} onChange={(e) => changePlatform(e.target.value)}>
                {platforms.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="form-row">
            <Field label="帳號類型" htmlFor="acc-type" required error={errors.accountType}>
              <Select id="acc-type" value={accountType} invalid={!!errors.accountType} onChange={(e) => setAccountType(e.target.value)}>
                {(platformMeta?.accountTypes ?? []).map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="帳號名稱" htmlFor="acc-name" required error={errors.name}>
              <TextInput
                id="acc-name"
                value={name}
                maxLength={60}
                invalid={!!errors.name}
                placeholder="例如：日日咖啡粉絲專頁"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          </div>

          <div className="form-row">
            <Field label="帳號代稱" htmlFor="acc-handle" hint="選填" error={errors.handle}>
              <TextInput
                id="acc-handle"
                value={handle}
                maxLength={60}
                invalid={!!errors.handle}
                placeholder="例如：@dailycoffee.tw"
                onChange={(e) => setHandle(e.target.value)}
              />
            </Field>
            <Field
              label="平台帳號 ID"
              htmlFor="acc-external"
              required
              error={errors.externalId}
              hint={platformMeta?.isMock ? '平台上的帳號或頁面 ID；模擬模式下以 err- 開頭可模擬連線失敗' : '平台上的帳號或頁面 ID'}
            >
              <TextInput
                id="acc-external"
                className="mono"
                value={externalId}
                maxLength={120}
                invalid={!!errors.externalId}
                onChange={(e) => setExternalId(e.target.value)}
              />
            </Field>
          </div>

          {typeDef && (
            <div className="acc-preview" aria-live="polite">
              <strong className="small">{typeDef.label}</strong>
              <div className="acc-preview-row">
                <span className="acc-preview-label">涵蓋內容</span>
                <span className="acc-chips">
                  {typeDef.contentTypes.map((ct) => (
                    <Badge key={ct} tone="blue">
                      {CONTENT_TYPE_LABELS[ct] ?? ct}
                    </Badge>
                  ))}
                </span>
              </div>
              <div className="acc-preview-row">
                <span className="acc-preview-label">支援動作</span>
                <CapabilityChips capabilities={typeDef.capabilities} />
              </div>
              <p className="muted small">加上刪除線的動作是平台 API 本身不支援，在工作台中也無法執行。</p>
            </div>
          )}
          <p className="muted small">新增後會立即測試一次連線。</p>
        </div>
      </form>
    </Modal>
  );
}

// ---------------- 編輯社群帳號 ----------------
function EditAccountModal({
  account,
  onClose,
  onSaved,
}: {
  account: SocialAccount;
  onClose: () => void;
  onSaved: (a: SocialAccount) => void;
}) {
  const { brands } = useAuth();
  const { accountTypeLabel } = useMeta();
  const [name, setName] = useState(account.name);
  const [handle, setHandle] = useState(account.handle);
  const [nameError, setNameError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const brandColor = brands.find((b) => b.id === account.brandId)?.color ?? FALLBACK_BRAND_COLOR;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    const trimmed = name.trim();
    if (!trimmed) return setNameError('請輸入帳號名稱');
    if (trimmed.length > 60) return setNameError('帳號名稱最多 60 個字');
    setNameError(null);
    setBusy(true);
    try {
      onSaved(await api.patch<SocialAccount>(`/accounts/${account.id}`, { name: trimmed, handle: handle.trim() }));
    } catch (err) {
      setServerError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="編輯社群帳號"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" form="acc-edit-form" variant="primary" loading={busy}>
            儲存
          </Button>
        </>
      }
    >
      <form id="acc-edit-form" onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="stack acc-form">
          {serverError && <Alert tone="danger">{serverError}</Alert>}
          <div className="acc-readonly">
            <PlatformIcon platform={account.platform} />
            <span>{accountTypeLabel(account.accountType)}</span>
            <BrandTag name={account.brandName} color={brandColor} />
            <span className="mono muted">{account.externalId}</span>
          </div>
          <Field label="帳號名稱" htmlFor="acc-edit-name" required error={nameError}>
            <TextInput
              id="acc-edit-name"
              value={name}
              maxLength={60}
              invalid={!!nameError}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="帳號代稱" htmlFor="acc-edit-handle" hint="選填，例如：@dailycoffee.tw">
            <TextInput id="acc-edit-handle" value={handle} maxLength={60} onChange={(e) => setHandle(e.target.value)} />
          </Field>
          <p className="muted small">
            品牌、平台、帳號類型與平台帳號 ID 建立後不可更改，以免不同品牌的留言與紀錄混在一起。如需改用其他平台帳號，請停用此帳號後重新新增。
          </p>
        </div>
      </form>
    </Modal>
  );
}
