// 品牌 AI 回覆風格：設定語氣、稱呼、常用語、禁用詞、不可承諾事項，並即時預覽各版本回覆。
import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useBrandScope } from '../../brand/BrandScope';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card, ErrorMessage, Field, Loading, PageHeader, Select, Switch, TextInput, Textarea } from '../../components/ui';
import type { BrandStyleInput, BrandStyleView, KnowledgeHit, SuggestionVariant } from '../../../../shared/types';
import './style.css';

const SAMPLES = ['好喜歡你們的產品！', '請問這個多少錢？', '用一個月就壞了，我要退款', '請問門市在哪裡？'];
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

interface Preview {
  categoryName: string;
  knowledgeGap: boolean;
  hits: KnowledgeHit[];
  variants: SuggestionVariant[];
}

export default function StylePage() {
  const { can } = useAuth();
  const { activeBrands, currentBrand } = useBrandScope();
  const toast = useToast();
  const editable = can('manageSettings');
  const [brandId, setBrandId] = useState(currentBrand?.id ?? activeBrands[0]?.id ?? 0);
  const [orig, setOrig] = useState<BrandStyleView | null>(null);
  const [form, setForm] = useState<BrandStyleInput | null>(null);
  const [text, setText] = useState({ commonPhrases: '', bannedWords: '', unsuitableTones: '', forbiddenPromises: '' });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [sample, setSample] = useState(SAMPLES[0]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const load = async (id: number) => {
    setError(null);
    try {
      const s = await api.get<BrandStyleView>(`/brands/${id}/style`);
      const { brandId: _b, updatedAt: _u, updatedByName: _n, ...input } = s;
      setOrig(s);
      setForm(input);
      setText({
        commonPhrases: s.commonPhrases.join('\n'),
        bannedWords: s.bannedWords.join('\n'),
        unsuitableTones: s.unsuitableTones.join('\n'),
        forbiddenPromises: s.forbiddenPromises.join('\n'),
      });
      setPreview(null);
    } catch (err) {
      setError(err);
    }
  };
  useEffect(() => {
    if (brandId) void load(brandId);
  }, [brandId]);

  const current = (): BrandStyleInput | null =>
    form && {
      ...form,
      commonPhrases: lines(text.commonPhrases),
      bannedWords: lines(text.bannedWords),
      unsuitableTones: lines(text.unsuitableTones),
      forbiddenPromises: lines(text.forbiddenPromises),
    };

  const runPreview = async (body = sample) => {
    const style = current();
    if (!style || !body.trim()) return;
    setPreviewing(true);
    try {
      setPreview(await api.post<Preview>(`/brands/${brandId}/style/preview`, { body, style }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    const style = current();
    if (!style) return;
    setSaving(true);
    try {
      const s = await api.put<BrandStyleView>(`/brands/${brandId}/style`, style);
      setOrig(s);
      toast.success('已儲存回覆風格，之後的 AI 建議會套用');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof BrandStyleInput>(k: K, v: BrandStyleInput[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <>
      <PageHeader
        title="AI 回覆風格"
        description="每個品牌各自設定。AI 產生回覆建議時會套用稱呼、語氣、表情符號、署名，並避開禁用詞。"
        actions={
          <Select value={brandId} onChange={(e) => setBrandId(Number(e.target.value))} aria-label="選擇品牌" style={{ width: 'auto' }}>
            {activeBrands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        }
      />
      {!editable && <Alert>你可以檢視與預覽；只有管理員可以修改。</Alert>}
      {error ? (
        <ErrorMessage error={error} onRetry={() => void load(brandId)} />
      ) : !form ? (
        <Loading />
      ) : (
        <div className="st-layout">
          <Card title="風格設定">
            <fieldset disabled={!editable} className="stack st-fields">
              <Field label="品牌個性">
                <Textarea rows={2} value={form.personality} onChange={(e) => set('personality', e.target.value)} placeholder="例如：像熟識的咖啡店店員，熱情、愛分享" />
              </Field>
              <Field label="說話方式">
                <Textarea rows={2} value={form.speakingStyle} onChange={(e) => set('speakingStyle', e.target.value)} />
              </Field>
              <div className="form-row">
                <Field label="語氣">
                  <TextInput value={form.tone} onChange={(e) => set('tone', e.target.value)} placeholder="例如：親切、溫暖" />
                </Field>
                <Field label="對顧客的稱呼" required>
                  <TextInput value={form.addressing} maxLength={10} onChange={(e) => set('addressing', e.target.value)} placeholder="您、你、爸爸媽媽" />
                </Field>
              </div>
              <div className="form-row">
                <Field label={`正式程度：${form.formality} / 5`}>
                  <input type="range" min={1} max={5} value={form.formality} onChange={(e) => set('formality', Number(e.target.value))} />
                </Field>
                <Field label={`幽默程度：${form.humor} / 5`}>
                  <input type="range" min={1} max={5} value={form.humor} onChange={(e) => set('humor', Number(e.target.value))} />
                </Field>
              </div>
              <div className="form-row">
                <Field label="回覆長度">
                  <Select value={form.replyLength} onChange={(e) => set('replyLength', e.target.value as BrandStyleInput['replyLength'])}>
                    <option value="short">簡短</option>
                    <option value="medium">適中</option>
                    <option value="long">詳細</option>
                  </Select>
                </Field>
                <Field label="表情符號">
                  <Select value={form.emojiUsage} onChange={(e) => set('emojiUsage', e.target.value as BrandStyleInput['emojiUsage'])}>
                    <option value="none">不使用</option>
                    <option value="light">少量</option>
                    <option value="frequent">常用</option>
                  </Select>
                </Field>
              </div>
              <Field label="署名" hint="會加在每則 AI 建議的最後，例如「— 日日咖啡小編」。">
                <TextInput value={form.signature} maxLength={40} onChange={(e) => set('signature', e.target.value)} />
              </Field>
              <Field label="常用語（一行一句）">
                <Textarea rows={4} value={text.commonPhrases} onChange={(e) => setText({ ...text, commonPhrases: e.target.value })} />
              </Field>
              <Field label="禁用詞（一行一個）" hint="回覆中出現禁用詞會被擋下，必須修改才能送出。">
                <Textarea rows={3} value={text.bannedWords} onChange={(e) => setText({ ...text, bannedWords: e.target.value })} />
              </Field>
              <Field label="不適合的語氣（一行一個）">
                <Textarea rows={2} value={text.unsuitableTones} onChange={(e) => setText({ ...text, unsuitableTones: e.target.value })} />
              </Field>
              <Field label="不可承諾事項（一行一項）" hint="會顯示在回覆建議旁提醒小編。">
                <Textarea rows={4} value={text.forbiddenPromises} onChange={(e) => setText({ ...text, forbiddenPromises: e.target.value })} />
              </Field>
              <Field label="提供的回覆版本">
                <div className="row-wrap">
                  {form.variants.map((v) => (
                    <Switch key={v.key} checked={v.enabled} label={v.label} onChange={(on) => set('variants', form.variants.map((x) => (x.key === v.key ? { ...x, enabled: on } : x)))} />
                  ))}
                </div>
              </Field>
            </fieldset>
            {editable && (
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                {orig?.updatedAt && (
                  <span className="muted small">
                    {orig.updatedByName ?? ''} 更新於 {formatDateTime(orig.updatedAt)}
                  </span>
                )}
                <Button variant="primary" onClick={() => void save()} loading={saving}>
                  儲存
                </Button>
              </div>
            )}
          </Card>

          <Card title="即時預覽" className="st-preview">
            <div className="stack">
              <div className="row-wrap">
                {SAMPLES.map((s) => (
                  <button key={s} className={`chip ${sample === s ? 'on' : ''}`} onClick={() => { setSample(s); void runPreview(s); }}>
                    {s}
                  </button>
                ))}
              </div>
              <Textarea rows={2} value={sample} onChange={(e) => setSample(e.target.value)} aria-label="範例留言" />
              <Button onClick={() => void runPreview()} loading={previewing}>
                用目前設定預覽（不會儲存）
              </Button>
              {preview && (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="row-wrap small">
                    AI 判斷：<Badge tone="blue">{preview.categoryName}</Badge>
                    {preview.knowledgeGap && <Badge tone="orange">知識不足</Badge>}
                    {preview.hits.map((h) => (
                      <Badge key={h.id} tone="teal">
                        📘 {h.title}
                      </Badge>
                    ))}
                  </div>
                  {preview.variants.map((v) => (
                    <div key={v.key} className="variant">
                      <Badge tone="purple">{v.label}</Badge>
                      <p>{v.body}</p>
                      {v.warnings.length > 0 && <p className="small warn-text">⚠ {v.warnings.map((w) => w.message).join('；')}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
