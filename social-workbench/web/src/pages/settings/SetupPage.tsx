// AI 快速設定：填一份店家資料 → AI 產生回覆風格、類型語氣、知識庫、標準回覆、回覆範例的草稿 → 店家確認修改 → 一次加入。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useBrandScope } from '../../brand/BrandScope';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card, Checkbox, Field, PageHeader, Select, TextInput, Textarea } from '../../components/ui';
import { KNOWLEDGE_CATEGORY_LABELS } from '../../../../shared/constants';
import type { BrandStyleInput, SetupApplyInput, SetupApplyResult, SetupDraft, SetupProfile } from '../../../../shared/types';
import './setup.css';

const EMPTY: SetupProfile = {
  businessName: '',
  industry: '',
  description: '',
  services: '',
  brandImage: '',
  audience: '',
  addressing: '您',
  emojiUsage: 'light',
  signature: '',
  address: '',
  hours: '',
  booking: '',
  contact: '',
  prices: '',
  otherFacts: '',
  forbiddenPromises: '',
};

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const words = (s: string) => [...new Set(s.split(/[、,，\n]/).map((x) => x.trim()).filter(Boolean))];

// 草稿暫存在這台電腦，避免重新整理後要重填（讀寫失敗時忽略）
const storeKey = (brandId: number) => `swb.setup.${brandId}`;
function loadSaved(brandId: number): SetupProfile | null {
  try {
    const raw = localStorage.getItem(storeKey(brandId));
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<SetupProfile>) } : null;
  } catch {
    return null;
  }
}
function save(brandId: number, p: SetupProfile) {
  try {
    localStorage.setItem(storeKey(brandId), JSON.stringify(p));
  } catch {
    /* 無法暫存時不影響使用 */
  }
}

type On<T> = T & { on: boolean };

interface Review {
  styleOn: boolean;
  style: BrandStyleInput;
  styleText: { commonPhrases: string; bannedWords: string; unsuitableTones: string; forbiddenPromises: string };
  toneNotes: On<SetupDraft['toneNotes'][number]>[];
  knowledge: On<SetupDraft['knowledge'][number] & { keywordText: string }>[];
  canned: On<SetupDraft['canned'][number]>[];
  examples: On<SetupDraft['examples'][number]>[];
  notes: string[];
  provider: SetupDraft['provider'];
}

function toReview(d: SetupDraft): Review {
  return {
    styleOn: true,
    style: d.style,
    styleText: {
      commonPhrases: d.style.commonPhrases.join('\n'),
      bannedWords: d.style.bannedWords.join('\n'),
      unsuitableTones: d.style.unsuitableTones.join('\n'),
      forbiddenPromises: d.style.forbiddenPromises.join('\n'),
    },
    toneNotes: d.toneNotes.map((t) => ({ ...t, on: true })),
    knowledge: d.knowledge.map((k) => ({ ...k, keywordText: k.keywords.join('、'), on: !k.exists })),
    canned: d.canned.map((c) => ({ ...c, on: !c.exists })),
    examples: d.examples.map((e) => ({ ...e, on: true })),
    notes: d.notes,
    provider: d.provider,
  };
}

export default function SetupPage() {
  const { activeBrands, currentBrand } = useBrandScope();
  const toast = useToast();
  const [brandId, setBrandId] = useState<number>(currentBrand?.id ?? activeBrands[0]?.id ?? 0);
  const brand = activeBrands.find((b) => b.id === brandId);
  const [p, setP] = useState<SetupProfile>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [done, setDone] = useState<SetupApplyResult | null>(null);

  useEffect(() => {
    if (!brandId) return;
    setP(loadSaved(brandId) ?? { ...EMPTY, businessName: brand?.name ?? '', signature: brand?.name ?? '' });
    setReview(null);
    setDone(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  const set = <K extends keyof SetupProfile>(k: K, v: SetupProfile[K]) =>
    setP((cur) => {
      const next = { ...cur, [k]: v };
      save(brandId, next);
      return next;
    });

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await api.post<SetupDraft>(`/brands/${brandId}/setup/draft`, p);
      setReview(toReview(d));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      const input: SetupApplyInput = {
        style: review.styleOn
          ? {
              ...review.style,
              commonPhrases: lines(review.styleText.commonPhrases),
              bannedWords: lines(review.styleText.bannedWords),
              unsuitableTones: lines(review.styleText.unsuitableTones),
              forbiddenPromises: lines(review.styleText.forbiddenPromises),
            }
          : null,
        toneNotes: review.toneNotes.filter((t) => t.on).map((t) => ({ categoryId: t.categoryId, note: t.note })),
        knowledge: review.knowledge.filter((k) => k.on).map((k) => ({ category: k.category, title: k.title, content: k.content, keywords: words(k.keywordText) })),
        canned: review.canned.filter((c) => c.on).map((c) => ({ categoryId: c.categoryId, title: c.title, body: c.body })),
        examples: review.examples
          .filter((e) => e.on)
          .map((e) => ({ categoryId: e.categoryId, scenario: e.scenario, sampleComment: e.sampleComment, goodReply: e.goodReply, badReply: e.badReply, notes: e.notes })),
      };
      const r = await api.post<SetupApplyResult>(`/brands/${brandId}/setup/apply`, input);
      setDone(r);
      setReview(null);
      toast.success('已加入設定');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="AI 快速設定"
        description="填一份店家基本資料，AI 會一次產生回覆風格、各類型語氣、知識庫、標準回覆與回覆範例。你確認、修改後才會加入，不會直接覆蓋。"
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
      <ol className="su-steps">
        <li className={!review && !done ? 'on' : ''}>1. 填寫店家資料</li>
        <li className={review ? 'on' : ''}>2. 確認 AI 產生的內容</li>
        <li className={done ? 'on' : ''}>3. 完成</li>
      </ol>
      {error && <Alert tone="danger">{error}</Alert>}

      {done ? (
        <Done result={done} onAgain={() => setDone(null)} />
      ) : review ? (
        <ReviewView review={review} setReview={setReview} busy={busy} onBack={() => setReview(null)} onApply={() => void apply()} />
      ) : (
        <ProfileForm p={p} set={set} busy={busy} onGenerate={() => void generate()} />
      )}
    </>
  );
}

// ---------------- 步驟 1：店家資料 ----------------
function ProfileForm({ p, set, busy, onGenerate }: { p: SetupProfile; set: <K extends keyof SetupProfile>(k: K, v: SetupProfile[K]) => void; busy: boolean; onGenerate: () => void }) {
  const ready = p.businessName.trim() && p.industry.trim();
  return (
    <div className="stack">
      <Card title="關於你的店">
        <div className="stack">
          <div className="form-row">
            <Field label="店名" required>
              <TextInput value={p.businessName} maxLength={60} onChange={(e) => set('businessName', e.target.value)} />
            </Field>
            <Field label="行業" required>
              <TextInput value={p.industry} maxLength={40} onChange={(e) => set('industry', e.target.value)} placeholder="例如：美髮店、咖啡店、寵物美容" />
            </Field>
          </div>
          <Field label="店家特色、主要在做什麼">
            <Textarea rows={2} maxLength={500} value={p.description} onChange={(e) => set('description', e.target.value)} placeholder="例如：專做韓系染燙，一對一服務，重視髮質健康" />
          </Field>
          <Field label="服務或商品" hint="一行一項，或用頓號分隔。">
            <Textarea rows={2} maxLength={1000} value={p.services} onChange={(e) => set('services', e.target.value)} placeholder="例如：剪髮、染髮、韓式燙髮、護髮" />
          </Field>
          <div className="form-row">
            <Field label="品牌形象、個性">
              <TextInput value={p.brandImage} maxLength={300} onChange={(e) => set('brandImage', e.target.value)} placeholder="例如：溫暖、細心、像朋友一樣的設計師" />
            </Field>
            <Field label="主要客群（選填）">
              <TextInput value={p.audience} maxLength={200} onChange={(e) => set('audience', e.target.value)} placeholder="例如：20～40 歲上班族女性" />
            </Field>
          </div>
          <div className="form-row">
            <Field label="怎麼稱呼顧客">
              <TextInput value={p.addressing} maxLength={10} onChange={(e) => set('addressing', e.target.value)} placeholder="您、你、親" />
            </Field>
            <Field label="表情符號">
              <Select value={p.emojiUsage} onChange={(e) => set('emojiUsage', e.target.value as SetupProfile['emojiUsage'])}>
                <option value="none">不使用</option>
                <option value="light">少量</option>
                <option value="frequent">可以常用</option>
              </Select>
            </Field>
            <Field label="回覆署名">
              <TextInput value={p.signature} maxLength={40} onChange={(e) => set('signature', e.target.value)} placeholder="例如：小美髮廊" />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="店家資訊（會原樣存成知識庫，AI 回答時只引用這些）">
        <div className="stack">
          <Alert>這些內容不會被 AI 改寫，請填正確、可以公開給顧客的資訊；沒有的可以留空，AI 遇到相關問題會請顧客私訊。</Alert>
          <div className="form-row">
            <Field label="地址">
              <TextInput value={p.address} maxLength={200} onChange={(e) => set('address', e.target.value)} />
            </Field>
            <Field label="營業時間">
              <TextInput value={p.hours} maxLength={300} onChange={(e) => set('hours', e.target.value)} placeholder="例如：週二至週日 11:00–20:00，週一公休" />
            </Field>
          </div>
          <div className="form-row">
            <Field label="預約或購買方式">
              <TextInput value={p.booking} maxLength={500} onChange={(e) => set('booking', e.target.value)} placeholder="例如：採預約制，請私訊粉專或 LINE 預約" />
            </Field>
            <Field label="聯絡方式">
              <TextInput value={p.contact} maxLength={300} onChange={(e) => set('contact', e.target.value)} placeholder="例如：電話 02-1234-5678、LINE @abc" />
            </Field>
          </div>
          <Field label="價格" hint="可以寫「起價」，例如：剪髮 600 元起。沒填的話，AI 遇到詢價會請顧客私訊。">
            <Textarea rows={2} maxLength={2000} value={p.prices} onChange={(e) => set('prices', e.target.value)} />
          </Field>
          <Field label="其他顧客常問的事（選填）" hint="一行一項，例如停車、付款方式、可否帶寵物。">
            <Textarea rows={2} maxLength={1000} value={p.otherFacts} onChange={(e) => set('otherFacts', e.target.value)} />
          </Field>
          <Field label="絕對不能承諾的事（選填）" hint="一行一項。AI 回覆時會避開，並在回覆區提醒小編。">
            <Textarea rows={2} maxLength={1000} value={p.forbiddenPromises} onChange={(e) => set('forbiddenPromises', e.target.value)} placeholder={'例如：保證效果\n免費重做'} />
          </Field>
        </div>
      </Card>

      <div className="su-actions">
        <span className="muted small">填好的資料會暫存在這台電腦，下次打開不用重填。</span>
        <Button variant="primary" loading={busy} disabled={!ready} onClick={onGenerate}>
          {busy ? 'AI 產生中（約 10～30 秒）…' : '✨ 產生設定草稿'}
        </Button>
      </div>
    </div>
  );
}

// ---------------- 步驟 2：確認 ----------------
function SectionHead({ title, all, onAll, count }: { title: string; all: boolean; onAll: (v: boolean) => void; count: string }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
      <span>
        {title} <span className="muted small">{count}</span>
      </span>
      <Checkbox label="全選" checked={all} onChange={onAll} />
    </div>
  );
}

function ReviewView({ review, setReview, busy, onBack, onApply }: { review: Review; setReview: (r: Review) => void; busy: boolean; onBack: () => void; onApply: () => void }) {
  const r = review;
  const upd = (patch: Partial<Review>) => setReview({ ...r, ...patch });
  const st = r.style;
  const setStyle = <K extends keyof BrandStyleInput>(k: K, v: BrandStyleInput[K]) => upd({ style: { ...st, [k]: v } });
  const editList = <T,>(list: T[], i: number, patch: Partial<T>) => list.map((x, j) => (j === i ? { ...x, ...patch } : x));
  const n = (xs: Array<{ on: boolean }>) => `（已選 ${xs.filter((x) => x.on).length} / ${xs.length}）`;
  const total = (r.styleOn ? 1 : 0) + [r.toneNotes, r.knowledge, r.canned, r.examples].reduce((s, xs) => s + xs.filter((x) => x.on).length, 0);

  return (
    <div className="stack">
      <Alert tone={r.provider === 'mock' ? 'warning' : 'success'}>
        {r.provider === 'mock' ? '以下內容由範本產生。' : `以下內容由 AI（${r.provider === 'gemini' ? 'Google Gemini' : 'Claude'}）依你的資料產生。`}
        請逐項確認，可以直接修改文字；取消勾選的項目不會加入。
      </Alert>
      {r.notes.map((t) => (
        <Alert key={t} tone="info">
          {t}
        </Alert>
      ))}

      <Card title={<SectionHead title="回覆風格" all={r.styleOn} onAll={(v) => upd({ styleOn: v })} count={r.styleOn ? '（會取代目前的風格設定）' : '（不套用）'} />}>
        <fieldset disabled={!r.styleOn} className="stack su-fieldset">
          <Field label="品牌個性">
            <Textarea rows={2} maxLength={200} value={st.personality} onChange={(e) => setStyle('personality', e.target.value)} />
          </Field>
          <Field label="說話方式">
            <Textarea rows={2} maxLength={300} value={st.speakingStyle} onChange={(e) => setStyle('speakingStyle', e.target.value)} />
          </Field>
          <div className="form-row">
            <Field label="語氣">
              <TextInput value={st.tone} maxLength={100} onChange={(e) => setStyle('tone', e.target.value)} />
            </Field>
            <Field label="回覆長度">
              <Select value={st.replyLength} onChange={(e) => setStyle('replyLength', e.target.value as BrandStyleInput['replyLength'])}>
                <option value="short">簡短</option>
                <option value="medium">中等</option>
                <option value="long">詳細</option>
              </Select>
            </Field>
          </div>
          <div className="form-row">
            <Field label="常用語（一行一句）">
              <Textarea rows={3} value={r.styleText.commonPhrases} onChange={(e) => upd({ styleText: { ...r.styleText, commonPhrases: e.target.value } })} />
            </Field>
            <Field label="禁用詞（一行一個）">
              <Textarea rows={3} value={r.styleText.bannedWords} onChange={(e) => upd({ styleText: { ...r.styleText, bannedWords: e.target.value } })} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="不適合的語氣（一行一個）">
              <Textarea rows={3} value={r.styleText.unsuitableTones} onChange={(e) => upd({ styleText: { ...r.styleText, unsuitableTones: e.target.value } })} />
            </Field>
            <Field label="不可承諾事項（一行一項）">
              <Textarea rows={3} value={r.styleText.forbiddenPromises} onChange={(e) => upd({ styleText: { ...r.styleText, forbiddenPromises: e.target.value } })} />
            </Field>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            稱呼：{st.addressing}・表情符號：{{ none: '不使用', light: '少量', frequent: '常用' }[st.emojiUsage]}・署名：{st.signature || '（無）'}・正式程度 {st.formality}/5・幽默程度 {st.humor}/5（加入後可到「AI 回覆風格」微調）
          </p>
        </fieldset>
      </Card>

      <Card title={<SectionHead title="各類型留言的語氣" all={r.toneNotes.every((t) => t.on)} onAll={(v) => upd({ toneNotes: r.toneNotes.map((t) => ({ ...t, on: v })) })} count={n(r.toneNotes)} />}>
        <div className="su-grid">
          {r.toneNotes.map((t, i) => (
            <div key={t.categoryId} className={`su-item ${t.on ? '' : 'off'}`}>
              <Checkbox label={<strong>{t.categoryName}</strong>} checked={t.on} onChange={(v) => upd({ toneNotes: editList(r.toneNotes, i, { on: v }) })} />
              <Textarea rows={3} maxLength={300} value={t.note} disabled={!t.on} onChange={(e) => upd({ toneNotes: editList(r.toneNotes, i, { note: e.target.value }) })} />
            </div>
          ))}
        </div>
      </Card>

      <Card title={<SectionHead title="知識庫" all={r.knowledge.every((k) => k.on)} onAll={(v) => upd({ knowledge: r.knowledge.map((k) => ({ ...k, on: v && !k.exists })) })} count={n(r.knowledge)} />}>
        {r.knowledge.length === 0 ? (
          <p className="muted small">沒有填店家資訊，所以沒有產生知識。可以回上一步補上地址、營業時間、價格等。</p>
        ) : (
          <div className="stack">
            {r.knowledge.map((k, i) => (
              <div key={k.title} className={`su-item ${k.on ? '' : 'off'}`}>
                <div className="row-wrap">
                  <Checkbox label={<strong>{k.title}</strong>} checked={k.on} disabled={k.exists} onChange={(v) => upd({ knowledge: editList(r.knowledge, i, { on: v }) })} />
                  <Badge tone="blue">{KNOWLEDGE_CATEGORY_LABELS[k.category]}</Badge>
                  {k.exists && <Badge>已有同名知識，將略過</Badge>}
                </div>
                <Textarea rows={2} maxLength={2000} value={k.content} disabled={!k.on} onChange={(e) => upd({ knowledge: editList(r.knowledge, i, { content: e.target.value }) })} />
                <Field label="關鍵字（顧客留言包含任一個字，AI 才會找到這則）">
                  <TextInput value={k.keywordText} disabled={!k.on} onChange={(e) => upd({ knowledge: editList(r.knowledge, i, { keywordText: e.target.value }) })} />
                </Field>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={<SectionHead title="標準回覆" all={r.canned.every((c) => c.on)} onAll={(v) => upd({ canned: r.canned.map((c) => ({ ...c, on: v && !c.exists })) })} count={n(r.canned)} />}>
        <p className="muted small" style={{ marginTop: 0 }}>
          {'{name}'} 會自動換成留言者名稱。
        </p>
        <div className="stack">
          {r.canned.map((c, i) => (
            <div key={`${c.title}-${i}`} className={`su-item ${c.on ? '' : 'off'}`}>
              <div className="row-wrap">
                <Checkbox label="" checked={c.on} disabled={c.exists} onChange={(v) => upd({ canned: editList(r.canned, i, { on: v }) })} />
                <TextInput value={c.title} maxLength={40} disabled={!c.on} style={{ maxWidth: 260 }} onChange={(e) => upd({ canned: editList(r.canned, i, { title: e.target.value }) })} aria-label="名稱" />
                <Badge tone="blue">{c.categoryName ?? '不限類型'}</Badge>
                {c.exists && <Badge>已有同名標準回覆，將略過</Badge>}
              </div>
              <Textarea rows={2} maxLength={2000} value={c.body} disabled={!c.on} onChange={(e) => upd({ canned: editList(r.canned, i, { body: e.target.value }) })} />
              {c.warnings.map((w) => (
                <p key={w} className="small warn-text" style={{ margin: 0 }}>
                  ⚠ {w}
                </p>
              ))}
            </div>
          ))}
        </div>
      </Card>

      <Card title={<SectionHead title="回覆範例（AI 參考的回覆習慣）" all={r.examples.every((e) => e.on)} onAll={(v) => upd({ examples: r.examples.map((e) => ({ ...e, on: v })) })} count={n(r.examples)} />}>
        <div className="stack">
          {r.examples.map((e, i) => (
            <div key={i} className={`su-item ${e.on ? '' : 'off'}`}>
              <div className="row-wrap">
                <Checkbox label={<strong>{e.scenario || '範例'}</strong>} checked={e.on} onChange={(v) => upd({ examples: editList(r.examples, i, { on: v }) })} />
                <Badge tone="blue">{e.categoryName ?? '不限類型'}</Badge>
              </div>
              <fieldset disabled={!e.on} className="stack su-fieldset">
                <Field label="顧客留言">
                  <TextInput value={e.sampleComment} onChange={(ev) => upd({ examples: editList(r.examples, i, { sampleComment: ev.target.value }) })} />
                </Field>
                <Field label="✅ 建議如何回覆">
                  <Textarea rows={2} value={e.goodReply} onChange={(ev) => upd({ examples: editList(r.examples, i, { goodReply: ev.target.value }) })} />
                </Field>
                <Field label="❌ 不建議如何回覆">
                  <TextInput value={e.badReply} onChange={(ev) => upd({ examples: editList(r.examples, i, { badReply: ev.target.value }) })} />
                </Field>
              </fieldset>
              {e.warnings.map((w) => (
                <p key={w} className="small warn-text" style={{ margin: 0 }}>
                  ⚠ {w}
                </p>
              ))}
            </div>
          ))}
        </div>
      </Card>

      <div className="su-actions su-sticky">
        <Button onClick={onBack} disabled={busy}>
          ← 回上一步修改資料
        </Button>
        <span className="spacer" />
        <span className="muted small">共 {total} 項要加入</span>
        <Button variant="primary" loading={busy} disabled={total === 0} onClick={onApply}>
          確認加入
        </Button>
      </div>
    </div>
  );
}

// ---------------- 步驟 3：完成 ----------------
function Done({ result, onAgain }: { result: SetupApplyResult; onAgain: () => void }) {
  return (
    <Card title="🎉 設定完成">
      <div className="stack">
        <ul className="su-done">
          {result.style && <li>回覆風格已更新</li>}
          <li>{result.toneNotes} 種留言類型的語氣</li>
          <li>{result.knowledge} 則知識（AI 回答時會引用）</li>
          <li>{result.canned} 則標準回覆</li>
          <li>{result.examples} 則回覆範例</li>
        </ul>
        {result.skipped.length > 0 && <Alert tone="warning">已略過：{result.skipped.join('、')}</Alert>}
        <p className="small" style={{ margin: 0 }}>
          接下來可以到 <Link to="/settings/style">AI 回覆風格</Link> 用「即時預覽」試試看，或到 <Link to="/knowledge">知識庫</Link>、<Link to="/library">回覆範本</Link> 繼續調整。
        </p>
        <div>
          <Button onClick={onAgain}>回到店家資料</Button>
        </div>
      </div>
    </Card>
  );
}
