// 多版本回覆建議（模擬 AI）與送出前檢查。
// 原則：事實內容只能直接引用知識庫；找不到知識時只產生「確認後回覆／請私訊」的安撫回覆，不編造價格、規格或承諾。
import type { DB } from '../db';
import { get, parseJson } from '../db';
import type { BrandStyleView, KnowledgeHit, ReplyWarning, StyleVariant } from '../../shared/types';
import { validKnowledgeText } from './knowledge';

export type FullStyle = Omit<BrandStyleView, 'brandId' | 'updatedAt' | 'updatedByName'>;

export const DEFAULT_VARIANTS: StyleVariant[] = [
  { key: 'friendly', label: '親切版', enabled: true },
  { key: 'concise', label: '簡潔版', enabled: true },
  { key: 'lively', label: '活潑版', enabled: true },
  { key: 'professional', label: '專業版', enabled: true },
];

export async function loadFullStyle(db: DB, brandId: number): Promise<BrandStyleView> {
  const s = await get<Record<string, unknown> & { updated_by_name: string | null }>(
    db,
    `SELECT bs.*, u.name AS updated_by_name FROM brand_styles bs LEFT JOIN users u ON u.id = bs.updated_by_id WHERE bs.brand_id = ?`,
    [brandId],
  );
  const savedVariants = parseJson<StyleVariant[]>(s?.variants as string, []);
  return {
    brandId,
    personality: (s?.personality as string) ?? '',
    speakingStyle: (s?.speaking_style as string) ?? '',
    tone: (s?.tone as string) ?? '',
    formality: (s?.formality as number) ?? 3,
    humor: (s?.humor as number) ?? 2,
    replyLength: (s?.reply_length as FullStyle['replyLength']) ?? 'medium',
    emojiUsage: (s?.emoji_usage as FullStyle['emojiUsage']) ?? 'light',
    addressing: (s?.addressing as string) || '您',
    commonPhrases: parseJson<string[]>(s?.common_phrases as string, []),
    bannedWords: parseJson<string[]>(s?.banned_words as string, []),
    unsuitableTones: parseJson<string[]>(s?.unsuitable_tones as string, []),
    forbiddenPromises: parseJson<string[]>(s?.forbidden_promises as string, []),
    signature: (s?.signature as string) ?? '',
    variants: DEFAULT_VARIANTS.map((d) => ({ ...d, enabled: savedVariants.find((v) => v.key === d.key)?.enabled ?? true })),
    updatedAt: (s?.updated_at as string) ?? '',
    updatedByName: s?.updated_by_name ?? null,
  };
}

export interface ComposeInput {
  body: string;
  categoryKey: string;
  riskFlags: string[];
  sentiment: string | null;
  brandName: string;
  style: FullStyle;
  hits: KnowledgeHit[];
  needsKnowledge: boolean;
  seed: number;
}

export interface ComposedVariant {
  key: string;
  label: string;
  body: string;
  knowledgeIds: number[];
}

type Situation = 'complaint' | 'sensitive' | 'praise' | 'question' | 'unclear';

function situationOf(i: ComposeInput): Situation {
  const f = new Set(i.riskFlags);
  if (f.has('safety') || f.has('sensitive')) return 'sensitive';
  if (['complaint', 'negative_review', 'malicious'].includes(i.categoryKey) || f.has('complaint') || f.has('refund') || f.has('compensation') || f.has('legal')) return 'complaint';
  if (['praise', 'general', 'no_reply'].includes(i.categoryKey)) return 'praise';
  if (i.categoryKey === 'other' || i.categoryKey === 'spam') return 'unclear';
  return 'question';
}

/** 取知識內容的前幾句（直接引用原文，不改寫數字） */
function quote(content: string, sentences: number): string {
  const parts = content.replace(/\s*\n+\s*/g, '').split(/(?<=[。！？!?])/).filter((p) => p.trim());
  return parts.slice(0, sentences).join('').trim();
}

const NOT_PROCESS = /私訊|處理|聯繫|說明書|抱歉|困擾|擔心|專人/;

export function composeVariants(i: ComposeInput): ComposedVariant[] {
  const st = i.style;
  const you = st.addressing || '您';
  const sit = situationOf(i);
  const pick = <T,>(list: T[], salt = 0): T => list[Math.abs(Math.floor(i.seed) + salt) % list.length];
  const careful = sit === 'complaint' || sit === 'sensitive';
  const emojiSet = st.emojiUsage === 'none' ? [''] : st.emojiUsage === 'light' ? ['😊', '🌱'] : ['☕', '😊', '🙌', '✨'];
  const dmPhrase = st.commonPhrases.find((p) => /私訊/.test(p)) ?? `麻煩${you}私訊提供訂單編號與聯絡方式`;
  const warmPhrases = st.commonPhrases.filter((p) => !NOT_PROCESS.test(p) && !/^(謝謝|感謝)/.test(p));
  const sign = st.signature ? `\n— ${st.signature}` : '';
  const facts = i.hits[0];

  const core = (len: 'full' | 'short'): { text: string; ids: number[] } => {
    const dm = `${dmPhrase.replace(/[，。！]$/, '')}，我們會由專人與${you}聯繫並協助處理。`;
    if (sit === 'complaint') return { text: dm, ids: [] };
    if (sit === 'sensitive') {
      if (facts) return { text: `${quote(facts.content, len === 'full' ? 2 : 1)}若${you}還有疑慮，${dm}`, ids: [facts.id] };
      return { text: `這類問題我們會請專人確認後再詳細說明，${dm}`, ids: [] };
    }
    if (sit === 'praise') return { text: '', ids: [] };
    if (sit === 'unclear') return { text: `想再跟${you}確認一下想詢問的內容，方便多說明一些嗎？`, ids: [] };
    // question
    if (facts) {
      const extra = len === 'full' && i.hits[1] ? quote(i.hits[1].content, 1) : '';
      return { text: quote(facts.content, len === 'full' ? 2 : 1) + extra, ids: extra ? [facts.id, i.hits[1].id] : [facts.id] };
    }
    if (i.needsKnowledge) return { text: `這部分我們需要再確認正確資訊，確認後會盡快回覆${you}；也歡迎私訊我們，由專人為${you}說明。`, ids: [] };
    return { text: `${dmPhrase.replace(/[，。！]$/, '')}，我們會請專責窗口與${you}聯繫。`, ids: [] };
  };

  const build = (key: string): { body: string; ids: number[] } | null => {
    const em = careful ? '' : pick(emojiSet);
    if (key === 'friendly') {
      const opening =
        sit === 'complaint' ? `造成${you}的困擾，真的非常抱歉。`
        : sit === 'sensitive' ? `謝謝${you}提出來，能理解${you}的擔心。`
        : sit === 'praise' ? `謝謝${you}的支持與分享${em ? `！${em}` : '！'}`
        : `謝謝${you}的詢問${em ? `！${em}` : '！'}`;
      const c = core('full');
      const closing = careful ? '' : warmPhrases.length ? pick(warmPhrases, 1) : `有任何問題都歡迎再告訴我們。`;
      return { body: [opening, c.text, closing].filter(Boolean).join(sit === 'praise' ? '' : '\n'), ids: c.ids };
    }
    if (key === 'concise') {
      const c = core('short');
      const opening = sit === 'complaint' ? `抱歉造成${you}的困擾。` : sit === 'praise' ? `謝謝${you}的支持！` : '';
      return { body: [opening, c.text].filter(Boolean).join(''), ids: c.ids };
    }
    if (key === 'lively') {
      if (careful) return null; // 客訴與安全議題不適合活潑語氣
      const e1 = st.emojiUsage === 'none' ? '' : pick(emojiSet, 2);
      const e2 = st.emojiUsage === 'none' ? '' : pick(emojiSet, 3);
      const opening = sit === 'praise' ? `哇，收到${you}的好評${e1 ? ` ${e1}` : ''}！` : `好問題${e1 ? ` ${e1}` : ''}！`;
      const c = core('full');
      const closing = sit === 'praise' ? `${i.brandName}會繼續加油，等${you}再來${e2 ? ` ${e2}` : '！'}` : `還有想知道的都可以問我們${e2 ? ` ${e2}` : '！'}`;
      return { body: [opening, c.text, closing].filter(Boolean).join(''), ids: c.ids };
    }
    if (key === 'professional') {
      const opening =
        sit === 'complaint' ? `非常抱歉造成${you}的不便，我們已收到${you}的反映。`
        : sit === 'sensitive' ? `感謝${you}提出這個問題。`
        : sit === 'praise' ? `感謝${you}對${i.brandName}的肯定。`
        : `感謝${you}的詢問。`;
      const c = core('full');
      const closing = sit === 'praise' ? '我們會持續提供更好的產品與服務。' : '如有其他問題，歡迎隨時與我們聯繫。';
      return { body: [opening, c.text, closing].filter(Boolean).join(''), ids: c.ids };
    }
    return null;
  };

  const out: ComposedVariant[] = [];
  for (const v of st.variants) {
    if (!v.enabled) continue;
    const b = build(v.key);
    if (!b) continue;
    let body = b.body.trim() + sign;
    for (const w of st.bannedWords) if (w && body.includes(w)) body = body.replaceAll(w, '');
    out.push({ key: v.key, label: v.label, body: body.replace(/[ \t]+\n/g, '\n').trim(), knowledgeIds: b.ids });
  }
  return out;
}

// ---------- 送出前檢查 ----------
const PROMISE_PATTERNS: Array<[RegExp, string]> = [
  [/保證|一定會|絕對|百分之百|100\s*%/, '含有保證或絕對性的說法'],
  [/全額退款|包退|退(你|您)?錢|退款\s*\d|賠(償)?\s*\d|補償\s*\d/, '提到退款或賠償內容'],
  [/免費(換|送|維修|寄)|送(你|您)一/, '提到免費或贈送'],
  [/(今天|明天|後天|\d+\s*天內|馬上|立刻).{0,6}(到貨|寄出|送達|修好|到府|出貨)/, '承諾了到貨、寄出或維修時間'],
];

export async function checkReply(db: DB, brandId: number, body: string, style?: FullStyle): Promise<ReplyWarning[]> {
  const st = style ?? (await loadFullStyle(db, brandId));
  const warnings: ReplyWarning[] = [];
  for (const w of st.bannedWords) {
    if (w && body.includes(w)) warnings.push({ level: 'block', code: 'banned_word', message: `使用了品牌禁用詞「${w}」，請修改後再送出` });
  }
  for (const [re, label] of PROMISE_PATTERNS) {
    const m = body.match(re);
    if (m) warnings.push({ level: 'confirm', code: 'promise', message: `${label}（「${m[0]}」），請確認這是品牌可以做到的承諾` });
  }
  const knowledge = (await validKnowledgeText(db, brandId)).replace(/[,\s]/g, '');
  const amounts = [...body.matchAll(/(?:NT\$|\$)?\s*(\d[\d,]*)\s*(?:元|塊)|(?:NT\$|\$)\s*(\d[\d,]*)/g)];
  for (const m of amounts) {
    const n = (m[1] ?? m[2]).replace(/,/g, '');
    if (!knowledge.includes(n)) warnings.push({ level: 'confirm', code: 'unverified_amount', message: `金額「${m[0].trim()}」在知識庫中找不到，請確認是否正確` });
  }
  for (const m of body.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g)) {
    if (!knowledge.includes(m[0])) warnings.push({ level: 'confirm', code: 'unverified_date', message: `日期「${m[0]}」在知識庫中找不到，請確認是否正確` });
  }
  for (const m of body.matchAll(/(\d+)\s*(%|折)/g)) {
    if (!knowledge.includes(m[0].replace(/\s/g, ''))) warnings.push({ level: 'confirm', code: 'unverified_discount', message: `折扣「${m[0]}」在知識庫中找不到，請確認是否正確` });
  }
  // 同樣的提醒只留一則
  return warnings.filter((w, idx) => warnings.findIndex((x) => x.message === w.message) === idx);
}
