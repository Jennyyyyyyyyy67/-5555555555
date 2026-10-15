// 相似留言分組（模擬 AI）：同一篇貼文底下問同一件事的留言歸成一組，方便批次查看、產生回覆與確認。
// 原則：客訴、退款、敏感、風險等需要個別判斷的留言不放進任何組，必須一則一則處理。

export interface GroupCandidate {
  id: number;
  postId: number;
  categoryKey: string;
  body: string;
  riskFlags: string[];
  riskLevel: string | null;
  sentiment: string | null;
}

export interface Intent {
  key: string;
  label: string;
  re: RegExp;
  /** false：只能批次標記（例如垃圾訊息），不批次回覆 */
  replyable: boolean;
}

/** 常見的同類問題（順序代表優先判斷的順序） */
export const INTENTS: Intent[] = [
  { key: 'price', label: '詢問價格', re: /多少錢|價格|價錢|售價|怎麼賣|一組多少|多少\s*[？?]?$|幾元|幾塊|價位|price|\$\$/i, replyable: true },
  { key: 'stock', label: '詢問是否有貨', re: /有貨|還有嗎|還有沒有|補貨|缺貨|現貨|預購|賣完/, replyable: true },
  { key: 'buy', label: '詢問購買方式', re: /哪裡買|怎麼買|在哪買|購買|下單|連結|網址|有賣|門市|通路|怎麼訂/, replyable: true },
  { key: 'shipping', label: '詢問運送', re: /運費|寄送|多久到|出貨|宅配|超商取貨|免運|寄到/, replyable: true },
  { key: 'spec', label: '詢問規格', re: /尺寸|規格|容量|顏色|大小|重量|幾公分|材質|幾毫升|ml/i, replyable: true },
  { key: 'usage', label: '詢問使用方式', re: /怎麼用|如何使用|使用方式|教學|怎麼裝|安裝|怎麼泡|怎麼洗/, replyable: true },
  { key: 'campaign', label: '詢問活動優惠', re: /優惠|折扣|活動|抽獎|贈品|折價|團購|特價/, replyable: true },
  { key: 'interest', label: '+1／想要', re: /^\s*\+\s*1\s*$|\+1|想要|求連結|我要|喊單|已私訊|私訊了|已私/, replyable: true },
  { key: 'praise', label: '稱讚與支持', re: /讚|好棒|喜歡|好可愛|好好喝|好吃|愛了|推推|太美|好美|好看|厲害|支持|加油/, replyable: true },
];

const SPAM_INTENT: Intent = { key: 'spam', label: '疑似垃圾訊息', re: /$^/, replyable: false };

/** 需要個別處理、不可批次的留言 */
const INDIVIDUAL_CATEGORIES = ['complaint', 'negative_review', 'after_sales', 'malicious', 'bulk_purchase', 'business_coop'];
const INDIVIDUAL_FLAGS = ['complaint', 'refund', 'compensation', 'sensitive', 'safety', 'privacy', 'legal', 'public_dispute', 'unverifiable_promise'];

export function needsIndividualHandling(c: Pick<GroupCandidate, 'categoryKey' | 'riskFlags' | 'riskLevel' | 'sentiment'>): boolean {
  return (
    INDIVIDUAL_CATEGORIES.includes(c.categoryKey) ||
    c.riskFlags.some((f) => INDIVIDUAL_FLAGS.includes(f)) ||
    c.riskLevel === 'medium' ||
    c.riskLevel === 'high' ||
    c.sentiment === 'negative'
  );
}

export function intentOf(c: Pick<GroupCandidate, 'categoryKey' | 'body'>): Intent | null {
  if (c.categoryKey === 'spam') return SPAM_INTENT;
  const text = c.body.trim();
  return INTENTS.find((i) => i.re.test(text)) ?? null;
}

const normalize = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

function bigrams(s: string): Set<string> {
  const t = normalize(s);
  const out = new Set<string>();
  if (t.length === 1) out.add(t);
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 字元二元組的 Jaccard 相似度（0～1） */
export function similarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

export interface RawGroup {
  key: string;
  postId: number;
  intentKey: string;
  label: string;
  replyable: boolean;
  ids: number[];
}

/**
 * 分組：同一篇貼文內，依「同類問題」分組；沒有對應問題類型的留言，再以文字相似度（≥ 0.5）分組。
 * 只回傳 2 則以上的組；需要個別處理的留言一律排除。
 */
export function groupComments(list: GroupCandidate[], threshold = 0.5): { groups: RawGroup[]; excludedIds: number[] } {
  const groups = new Map<string, RawGroup>();
  const excludedIds: number[] = [];
  const loose: GroupCandidate[] = [];
  for (const c of list) {
    if (needsIndividualHandling(c)) {
      excludedIds.push(c.id);
      continue;
    }
    const intent = intentOf(c);
    if (!intent) {
      loose.push(c);
      continue;
    }
    const key = `${c.postId}:${intent.key}`;
    const g = groups.get(key) ?? { key, postId: c.postId, intentKey: intent.key, label: intent.label, replyable: intent.replyable, ids: [] };
    g.ids.push(c.id);
    groups.set(key, g);
  }
  // 文字相似：與組內第一則比較
  const clusters: Array<{ head: GroupCandidate; items: GroupCandidate[] }> = [];
  for (const c of loose) {
    const hit = clusters.find((k) => k.head.postId === c.postId && k.head.categoryKey === c.categoryKey && similarity(k.head.body, c.body) >= threshold);
    if (hit) hit.items.push(c);
    else clusters.push({ head: c, items: [c] });
  }
  for (const k of clusters) {
    const key = `${k.head.postId}:sim:${k.head.id}`;
    const short = k.head.body.trim().slice(0, 12);
    groups.set(key, { key, postId: k.head.postId, intentKey: 'similar', label: `內容相似：「${short}${k.head.body.trim().length > 12 ? '…' : ''}」`, replyable: true, ids: k.items.map((x) => x.id) });
  }
  return { groups: [...groups.values()].filter((g) => g.ids.length >= 2), excludedIds };
}

/**
 * 批次回覆的措辭變化：核心內容（事實）完全相同，只換開頭稱呼，避免每則都是一模一樣的罐頭文字。
 */
export function personalize(body: string, authorName: string, index: number, addressing = '您'): string {
  const name = authorName.replace(/^@/, '').trim();
  if (!name) return body;
  const hello = addressing === '你' ? '你好' : '您好';
  const openings = [`${name} ${hello}～`, `Hi ${name}，`, `${name}，`, `嗨 ${name}！`];
  return `${openings[index % openings.length]}${body}`;
}
