import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useBrandScope } from '../../brand/BrandScope';
import { useMeta } from '../../lib/meta';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { formatPercent, formatRelative, formatShortDateTime, formatDateTime } from '../../lib/format';
import { useToast } from '../../components/Toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorMessage,
  Field,
  Loading,
  Modal,
  PageHeader,
  Select,
  Switch,
  Textarea,
  TextInput,
} from '../../components/ui';
import { BrandTag, IconEdit, IconPlus, IconShield, PlatformIcon } from '../../components/icons';
import {
  PRIORITY_LABELS,
  RISK_LEVEL_LABELS,
  SENTIMENT_LABELS,
  CONTENT_TYPE_LABELS,
} from '../../../../shared/constants';
import type {
  AutomationAction,
  AutomationDecision,
  AutomationRecentItem,
  AutomationRule,
  AutomationRuleInput,
  AutomationRulesResponse,
  SimulatePostOption,
  SimulateResult,
} from '../../../../shared/types';
import './automation.css';

const ACTION_LABELS: Record<AutomationAction, string> = { auto_reply: '自動回覆', auto_like: '自動按讚' };
type Tab = 'rules' | 'test' | 'recent';

const EXAMPLES: Array<{ label: string; body: string }> = [
  { label: '稱讚', body: '咖啡超好喝！已經回購第三次了 👍' },
  { label: '一般互動', body: '謝謝分享～' },
  { label: '詢價', body: '請問這個多少錢？' },
  { label: '客訴', body: '買不到一個月就漏水，品質到底怎樣？' },
  { label: '退款', body: '很好喝，但寄來的盒子破了，我想退款' },
  { label: '敏感議題', body: '奶瓶用熱水消毒會不會釋出塑化劑？' },
  { label: '要求承諾', body: '很喜歡！可以保證明天到貨嗎？' },
  { label: '稱讚但帶負面', body: '以前很好喝，這次很失望' },
];

export default function AutomationPage() {
  const { can } = useAuth();
  const canManage = can('manageAutomation');
  const { brandParam } = useBrandScope();
  const [tab, setTab] = useState<Tab>('rules');
  const [editing, setEditing] = useState<{ rule: AutomationRule | null } | null>(null);
  const rules = useQuery(() => api.get<AutomationRulesResponse>('/automation/rules', { brand: brandParam }), [brandParam]);

  return (
    <>
      <PageHeader
        title="自動回覆"
        description="符合規則的低風險留言（例如單純稱讚）由 AI 依品牌語氣自動回覆。涉及客訴、退款、補償、敏感議題、無法確認的承諾或 AI 沒有把握時，一律交給人工處理。"
        actions={
          canManage && tab === 'rules' ? (
            <Button variant="primary" icon={<IconPlus />} onClick={() => setEditing({ rule: null })}>
              新增規則
            </Button>
          ) : undefined
        }
      />
      <div className="am-tabs" role="tablist">
        {(
          [
            ['rules', '規則'],
            ['test', '測試與模擬'],
            ['recent', '最近執行紀錄'],
          ] as Array<[Tab, string]>
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`am-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'rules' && (
        <RulesTab
          data={rules.data}
          loading={rules.loading}
          error={rules.error}
          reload={rules.reload}
          canManage={canManage}
          onEdit={(rule) => setEditing({ rule })}
        />
      )}
      {tab === 'test' && <TestTab />}
      {tab === 'recent' && <RecentTab />}

      {editing && rules.data && (
        <RuleModal
          rule={editing.rule}
          meta={rules.data.meta}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void rules.reload();
          }}
        />
      )}
    </>
  );
}

// ---------------- 規則 ----------------
function RulesTab({
  data,
  loading,
  error,
  reload,
  canManage,
  onEdit,
}: {
  data: AutomationRulesResponse | undefined;
  loading: boolean;
  error: unknown;
  reload: () => Promise<void>;
  canManage: boolean;
  onEdit: (rule: AutomationRule) => void;
}) {
  const { activeBrands, currentBrand } = useBrandScope();
  const toast = useToast();
  const [deleting, setDeleting] = useState<AutomationRule | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const brands = currentBrand ? [currentBrand] : activeBrands;

  const toggle = async (rule: AutomationRule, isActive: boolean) => {
    setBusy(rule.id);
    try {
      await api.patch(`/automation/rules/${rule.id}`, { isActive });
      toast.success(isActive ? `已啟用「${rule.name}」` : `已停用「${rule.name}」`);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorMessage error={error} onRetry={() => void reload()} />;
  if (!data) return null;

  return (
    <div className="stack">
      <Card
        title={
          <h2 className="row">
            <IconShield size={16} /> 強制轉人工條件（系統固定，無法關閉）
          </h2>
        }
      >
        <p className="muted small" style={{ marginBottom: 10 }}>
          即使留言符合自動回覆規則，只要出現以下任一情況，系統一律交給人工處理：
        </p>
        <ul className="am-force-list">
          {data.meta.forceHumanRules.map((r) => (
            <li key={r.code}>{r.label}</li>
          ))}
        </ul>
        <p className="muted small" style={{ marginTop: 10 }}>
          自動回覆目前只開放「稱讚」「一般互動」這類不需要事實資訊的留言。產品、價格等問題需要知識庫（階段 3）才能可靠回答，在那之前都由人工處理。
        </p>
      </Card>

      {brands.map((b) => {
        const list = data.rules.filter((r) => r.brandId === b.id && r.sortOrder < 99999);
        return (
          <Card key={b.id} title={<BrandTag name={b.name} color={b.color} />} bodyClassName="">
            {list.length === 0 ? (
              <EmptyState title="尚未設定自動回覆" description="這個品牌的所有留言目前都由人工處理。" />
            ) : (
              <ul className="am-rule-list">
                {list.map((r) => (
                  <RuleRow
                    key={r.id}
                    rule={r}
                    canManage={canManage}
                    busy={busy === r.id}
                    onToggle={(v) => void toggle(r, v)}
                    onEdit={() => onEdit(r)}
                    onDelete={() => setDeleting(r)}
                  />
                ))}
              </ul>
            )}
          </Card>
        );
      })}

      <ConfirmDialog
        open={!!deleting}
        title="刪除自動化規則"
        message={
          <>
            確定要刪除「{deleting?.name}」嗎？刪除後符合條件的留言會改由人工處理。已經執行過的自動回覆紀錄會完整保留。
          </>
        }
        confirmText="刪除"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.del(`/automation/rules/${deleting.id}`);
            toast.success('已刪除規則');
            setDeleting(null);
            await reload();
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
    </div>
  );
}

function RuleRow({
  rule,
  canManage,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  rule: AutomationRule;
  canManage: boolean;
  busy: boolean;
  onToggle: (v: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { meta, platformLabel } = useMeta();
  const catName = (key: string) => meta?.categories.find((c) => c.key === key)?.name ?? key;
  return (
    <li className={`am-rule ${rule.isActive ? '' : 'off'}`}>
      <div className="am-rule-main">
        <div className="row-wrap">
          <strong>{rule.name}</strong>
          <Badge tone={rule.action === 'auto_reply' ? 'purple' : 'blue'}>{ACTION_LABELS[rule.action]}</Badge>
          {!rule.isActive && <Badge>已停用</Badge>}
        </div>
        {rule.description && <p className="muted small">{rule.description}</p>}
        <div className="am-rule-meta small">
          <span>類型：{rule.categories.map(catName).join('、')}</span>
          <span className="row" style={{ gap: 4 }}>
            平台：
            {rule.platforms.length === 0 ? '全部' : rule.platforms.map((p) => <PlatformIcon key={p} platform={p} size={16} />)}
            {rule.platforms.length > 0 && <span className="sr-only">{rule.platforms.map(platformLabel).join('、')}</span>}
          </span>
          <span>AI 信心 ≥ {formatPercent(rule.minConfidence)}</span>
          <span>近 7 天執行 {rule.firedLast7Days} 次</span>
          <span className="muted" title={formatDateTime(rule.updatedAt)}>
            {rule.updatedByName ? `${rule.updatedByName} ` : ''}更新於 {formatRelative(rule.updatedAt)}
          </span>
        </div>
      </div>
      <div className="am-rule-actions">
        <Switch label={rule.isActive ? '啟用中' : '已停用'} checked={rule.isActive} disabled={!canManage || busy} onChange={onToggle} />
        {canManage && (
          <span className="row-actions">
            <Button size="sm" variant="ghost" icon={<IconEdit />} onClick={onEdit}>
              編輯
            </Button>
            <Button size="sm" variant="ghost" onClick={onDelete}>
              刪除
            </Button>
          </span>
        )}
      </div>
    </li>
  );
}

function RuleModal({
  rule,
  meta: am,
  onClose,
  onSaved,
}: {
  rule: AutomationRule | null;
  meta: AutomationRulesResponse['meta'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { activeBrands, currentBrand } = useBrandScope();
  const { meta } = useMeta();
  const toast = useToast();
  const [form, setForm] = useState<AutomationRuleInput>(() => ({
    brandId: rule?.brandId ?? currentBrand?.id ?? activeBrands[0]?.id ?? 0,
    name: rule?.name ?? '',
    description: rule?.description ?? '',
    action: rule?.action ?? 'auto_reply',
    categories: rule?.categories ?? ['praise'],
    platforms: rule?.platforms ?? [],
    minConfidence: rule?.minConfidence ?? am.minConfidenceFloor,
    isActive: rule?.isActive ?? true,
  }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const allowed = form.action === 'auto_reply' ? am.autoReplyCategories : am.autoLikeCategories;
  const categories = (meta?.categories ?? []).filter((c) => c.isActive);
  const set = <K extends keyof AutomationRuleInput>(k: K, v: AutomationRuleInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return setError('請輸入規則名稱');
    const cats = form.categories.filter((c) => allowed.includes(c));
    if (cats.length === 0) return setError('請至少選擇一種留言類型');
    setSaving(true);
    setError(null);
    try {
      const body = { ...form, categories: cats };
      if (rule) {
        const { brandId: _b, ...patch } = body;
        await api.patch(`/automation/rules/${rule.id}`, patch);
      } else {
        await api.post('/automation/rules', body);
      }
      toast.success(rule ? '已更新規則' : '已新增規則');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={rule ? '編輯自動化規則' : '新增自動化規則'}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" type="submit" form="rule-form" loading={saving}>
            {rule ? '儲存' : '新增規則'}
          </Button>
        </>
      }
    >
      <form id="rule-form" onSubmit={submit} className="stack">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="form-row">
          <Field label="品牌" required>
            <Select value={form.brandId} disabled={!!rule} onChange={(e) => set('brandId', Number(e.target.value))}>
              {activeBrands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="規則名稱" required>
            <TextInput value={form.name} maxLength={60} onChange={(e) => set('name', e.target.value)} placeholder="例如：稱讚自動感謝" />
          </Field>
        </div>
        <Field label="說明" hint="給團隊看的備註，例如為什麼開啟這條規則">
          <Textarea rows={2} value={form.description} maxLength={300} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Field label="動作" required>
          <div className="am-choice">
            {(['auto_reply', 'auto_like'] as AutomationAction[]).map((a) => (
              <label key={a} className={`am-choice-card ${form.action === a ? 'active' : ''}`}>
                <input type="radio" name="action" checked={form.action === a} onChange={() => set('action', a)} />
                <span>
                  <strong>{ACTION_LABELS[a]}</strong>
                  <span className="muted small" style={{ display: 'block' }}>
                    {a === 'auto_reply' ? 'AI 依品牌風格產生回覆並直接送出，留言標為已完成。' : '只按讚，不回覆。目前只有 Facebook 支援。'}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="適用的留言類型" required hint="其他類型涉及事實資訊或風險，必須由人工處理，無法設定自動化。">
          <div className="am-check-grid">
            {categories.map((c) => {
              const ok = allowed.includes(c.key);
              return (
                <span key={c.key} className={ok ? '' : 'am-disabled'} title={ok ? undefined : '此類型不可自動處理'}>
                  <Checkbox
                    label={c.name}
                    disabled={!ok}
                    checked={ok && form.categories.includes(c.key)}
                    onChange={(v) => set('categories', v ? [...form.categories, c.key] : form.categories.filter((k) => k !== c.key))}
                  />
                </span>
              );
            })}
          </div>
        </Field>
        <Field label="適用平台" hint="都不勾選代表全部平台。">
          <div className="row-wrap">
            {(meta?.platforms ?? []).map((p) => (
              <Checkbox
                key={p.key}
                label={p.label}
                checked={form.platforms.includes(p.key)}
                onChange={(v) => set('platforms', v ? [...form.platforms, p.key] : form.platforms.filter((k) => k !== p.key))}
              />
            ))}
          </div>
        </Field>
        <div className="form-row">
          <Field label={`AI 信心門檻：${formatPercent(form.minConfidence)}`} hint={`最低 ${formatPercent(am.minConfidenceFloor)}；門檻越高，自動處理越保守。`}>
            <input
              type="range"
              min={am.minConfidenceFloor}
              max={1}
              step={0.01}
              value={form.minConfidence}
              onChange={(e) => set('minConfidence', Number(e.target.value))}
            />
          </Field>
          <Field label="狀態">
            <Switch label={form.isActive ? '儲存後立即啟用' : '先不啟用'} checked={form.isActive} onChange={(v) => set('isActive', v)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

// ---------------- 測試與模擬 ----------------
function TestTab() {
  const { activeBrands, currentBrand } = useBrandScope();
  const { meta } = useMeta();
  const [brandId, setBrandId] = useState(currentBrand?.id ?? activeBrands[0]?.id ?? 0);
  const [platform, setPlatform] = useState('facebook');
  const [body, setBody] = useState('');
  const [result, setResult] = useState<AutomationDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (text = body) => {
    if (!text.trim()) return setError('請輸入留言內容');
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post<AutomationDecision>('/automation/test', { brandId, platform, body: text, rating: platform === 'google' ? 5 : null }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="am-test-grid">
      <Card title="測試一則留言" className="am-test-card">
        <p className="muted small" style={{ marginBottom: 12 }}>
          看看 AI 會怎麼判斷、會不會自動回覆。只是測試，不會建立任何資料。
        </p>
        <div className="stack">
          <div className="form-row">
            <Field label="品牌">
              <Select value={brandId} onChange={(e) => setBrandId(Number(e.target.value))}>
                {activeBrands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="平台">
              <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                {(meta?.platforms ?? []).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="留言內容">
            <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="輸入一則顧客留言…" />
          </Field>
          <div className="row-wrap">
            <span className="muted small">試試看：</span>
            {EXAMPLES.map((x) => (
              <button
                key={x.label}
                type="button"
                className="am-chip"
                onClick={() => {
                  setBody(x.body);
                  void run(x.body);
                }}
              >
                {x.label}
              </button>
            ))}
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          <div>
            <Button variant="primary" loading={busy} onClick={() => void run()}>
              測試
            </Button>
          </div>
          {result && <DecisionPanel result={result} />}
        </div>
      </Card>
      <SimulateCard />
    </div>
  );
}

function SimulateCard() {
  const { brandParam } = useBrandScope();
  const posts = useQuery(() => api.get<SimulatePostOption[]>('/automation/posts', { brand: brandParam }), [brandParam]);
  const [postId, setPostId] = useState<number | ''>('');
  const [authorName, setAuthorName] = useState('測試顧客');
  const [body, setBody] = useState('');
  const [rating, setRating] = useState(5);
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const selected = posts.data?.find((p) => p.id === postId);
  const grouped = useMemo(() => {
    const m = new Map<string, SimulatePostOption[]>();
    for (const p of posts.data ?? []) {
      const k = `${p.brandName}・${p.accountName}`;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()];
  }, [posts.data]);

  const submit = async () => {
    if (!postId) return setError('請選擇要留言的貼文');
    if (!body.trim()) return setError('請輸入留言內容');
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<SimulateResult>('/automation/simulate', {
        postId,
        authorName,
        body,
        rating: selected?.contentType === 'business_profile' ? rating : null,
      });
      setResult(r);
      toast.success(r.decision === 'auto_replied' ? 'AI 已自動回覆' : r.decision === 'auto_liked' ? '已自動按讚' : '已交給人工處理');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="模擬收到新留言" className="am-test-card">
      <p className="muted small" style={{ marginBottom: 12 }}>
        在模擬平台上送出一則留言，系統會走完整流程：收到留言 → AI 判斷 → 安全檢查 → 規則 → 自動回覆或交給人工，並留下紀錄。結果會出現在收件匣。
      </p>
      {posts.loading && !posts.data ? (
        <Loading />
      ) : posts.error ? (
        <ErrorMessage error={posts.error} onRetry={() => void posts.reload()} />
      ) : (
        <div className="stack">
          <Field label="留言在哪篇內容">
            <Select value={postId} onChange={(e) => setPostId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">請選擇貼文、廣告或影片</option>
              {grouped.map(([group, list]) => (
                <optgroup key={group} label={group}>
                  {list.map((p) => (
                    <option key={p.id} value={p.id}>
                      {`${CONTENT_TYPE_LABELS[p.contentType]}｜${p.title}`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <div className="form-row">
            <Field label="留言者名稱">
              <TextInput value={authorName} maxLength={40} onChange={(e) => setAuthorName(e.target.value)} />
            </Field>
            {selected?.contentType === 'business_profile' && (
              <Field label="評論星等">
                <Select value={rating} onChange={(e) => setRating(Number(e.target.value))}>
                  {[5, 4, 3, 2, 1].map((n) => (
                    <option key={n} value={n}>
                      {'★'.repeat(n)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <Field label="留言內容">
            <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="例如：咖啡超好喝！" />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <div>
            <Button variant="primary" loading={busy} onClick={() => void submit()}>
              送出模擬留言
            </Button>
          </div>
          {result && (
            <>
              <DecisionPanel result={result} />
              <p className="small muted">
                已建立留言 #{result.commentId}
                {result.slaMinutes ? `，首次回覆時限 ${result.slaMinutes} 分鐘（${formatShortDateTime(result.slaDueAt)} 前）` : '，此類型不計算回覆時效'}。
                <Link to="/inbox"> 到收件匣查看 →</Link>
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function DecisionPanel({ result }: { result: AutomationDecision }) {
  const a = result.analysis;
  const auto = result.decision !== 'human';
  return (
    <div className={`am-result ${auto ? 'auto' : 'human'}`}>
      <div className="am-result-head">
        <Badge tone={auto ? 'green' : 'orange'}>
          {result.decision === 'auto_replied' ? '會自動回覆' : result.decision === 'auto_liked' ? '會自動按讚' : '交給人工處理'}
        </Badge>
        <span>{result.explanation}</span>
      </div>
      <dl className="am-analysis">
        <div>
          <dt>留言類型</dt>
          <dd>{a.categoryName}</dd>
        </div>
        <div>
          <dt>AI 信心</dt>
          <dd>
            <span className="am-bar" aria-hidden>
              <span style={{ width: `${Math.round(a.confidence * 100)}%` }} />
            </span>
            {formatPercent(a.confidence)}
          </dd>
        </div>
        <div>
          <dt>情緒</dt>
          <dd>{SENTIMENT_LABELS[a.sentiment]}</dd>
        </div>
        <div>
          <dt>風險</dt>
          <dd>{RISK_LEVEL_LABELS[a.riskLevel]}</dd>
        </div>
        <div>
          <dt>優先級</dt>
          <dd>{PRIORITY_LABELS[a.priority]}</dd>
        </div>
        <div>
          <dt>標籤</dt>
          <dd className="row-wrap">{a.tags.length ? a.tags.map((t) => <Badge key={t}>{t}</Badge>) : '—'}</dd>
        </div>
      </dl>
      {result.forceHuman.length > 0 && (
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
            需要人工處理的原因
          </div>
          <ul className="am-force-list compact">
            {result.forceHuman.map((r) => (
              <li key={r.code}>{r.label}</li>
            ))}
          </ul>
        </div>
      )}
      {result.replyBody && (
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
            AI 回覆內容
          </div>
          <blockquote className="am-reply">{result.replyBody}</blockquote>
        </div>
      )}
      <p className="muted small">判斷依據：{a.reasons.join('；')}</p>
    </div>
  );
}

// ---------------- 最近執行紀錄 ----------------
function RecentTab() {
  const { brandParam } = useBrandScope();
  const recent = useQuery(() => api.get<AutomationRecentItem[]>('/automation/recent', { brand: brandParam }), [brandParam]);
  if (recent.loading && !recent.data) return <Loading />;
  if (recent.error) return <ErrorMessage error={recent.error} onRetry={() => void recent.reload()} />;
  if (!recent.data?.length) return <EmptyState title="還沒有自動化紀錄" description="可以到「測試與模擬」送出一則模擬留言試試看。" />;
  return (
    <Card bodyClassName="">
      <ul className="am-recent">
        {recent.data.map((x) => (
          <li key={x.id}>
            <div className="row-wrap">
              <Badge tone={x.action === 'comment.auto_reply' ? 'green' : x.action === 'comment.auto_like' ? 'blue' : 'orange'}>
                {x.action === 'comment.auto_reply' ? '自動回覆' : x.action === 'comment.auto_like' ? '自動按讚' : '轉人工'}
              </Badge>
              <span className="muted small" title={formatDateTime(x.createdAt)}>
                {formatShortDateTime(x.createdAt)}・{x.brandName}
              </span>
            </div>
            {x.commentBody && (
              <p>
                <strong>{x.authorName}</strong>：{x.commentBody}
              </p>
            )}
            {x.replyBody && <blockquote className="am-reply">{x.replyBody}</blockquote>}
            <p className="muted small">{x.summary}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
