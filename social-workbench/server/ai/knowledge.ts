// 知識檢索：AI 只能引用「已審核、啟用中、在有效期限內」的品牌知識，找不到就標記「知識不足」，不自行編造。
import type { DB } from '../db';
import { all, parseJson } from '../db';
import type { KnowledgeCategory } from '../../shared/constants';
import type { KnowledgeHit, KnowledgeSearchResult } from '../../shared/types';

/** 需要事實知識才能回答的留言類型 */
export const NEEDS_KNOWLEDGE_CATEGORIES = ['product_inquiry', 'price_inquiry', 'purchase_inquiry', 'usage', 'after_sales', 'bulk_purchase', 'business_coop'];

/** 各留言類型優先參考的知識分類 */
const PREFERRED: Record<string, KnowledgeCategory[]> = {
  product_inquiry: ['product_info', 'spec', 'faq'],
  price_inquiry: ['price', 'campaign'],
  purchase_inquiry: ['faq', 'campaign', 'brand_intro', 'product_info'],
  usage: ['usage', 'installation', 'faq'],
  after_sales: ['warranty', 'after_sales'],
  complaint: ['warranty', 'after_sales'],
  bulk_purchase: ['faq', 'other', 'price'],
  business_coop: ['other', 'brand_intro'],
};

export function needsKnowledge(categoryKey: string): boolean {
  return NEEDS_KNOWLEDGE_CATEGORIES.includes(categoryKey);
}

/** 在有效期間內（以日期字串或 ISO 時間比較） */
export function validState(validFrom: string | null, validTo: string | null, now = new Date()): 'valid' | 'expired' | 'upcoming' {
  const t = now.getTime();
  if (validFrom && Date.parse(validFrom) > t) return 'upcoming';
  // 只填日期時，當天整天都有效
  if (validTo) {
    const end = /^\d{4}-\d{2}-\d{2}$/.test(validTo) ? Date.parse(`${validTo}T23:59:59+08:00`) : Date.parse(validTo);
    if (end < t) return 'expired';
  }
  return 'valid';
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

export interface KnowledgeRow {
  id: number;
  category: KnowledgeCategory;
  title: string;
  content: string;
  keywords: string;
  valid_from: string | null;
  valid_to: string | null;
}

/** 依留言內容排序可用知識（純函式：示範資料建立時也會用到） */
export function rankKnowledge(
  rows: KnowledgeRow[],
  input: { body: string; categoryKey: string; categoryName: string; limit?: number },
  now = new Date(),
): KnowledgeSearchResult {
  const text = norm(input.body);
  const preferred = PREFERRED[input.categoryKey] ?? [];
  const scored: Array<{ row: KnowledgeRow; score: number; matched: string[] }> = [];
  for (const row of rows) {
    const matched = parseJson<string[]>(row.keywords, []).filter((k) => k.trim() && text.includes(norm(k)));
    if (matched.length === 0) continue;
    const score = matched.reduce((s, k) => s + Math.min(4, [...k].length), 0) + (preferred.includes(row.category) ? 3 : 0);
    scored.push({ row, score, matched });
  }
  scored.sort((a, b) => b.score - a.score || a.row.id - b.row.id);

  const hits: KnowledgeHit[] = [];
  const skipped: KnowledgeSearchResult['skipped'] = [];
  for (const s of scored) {
    const state = validState(s.row.valid_from, s.row.valid_to, now);
    if (state !== 'valid') {
      skipped.push({ id: s.row.id, title: s.row.title, reason: state === 'expired' ? `已於 ${s.row.valid_to} 到期` : `${s.row.valid_from} 才開始生效` });
      continue;
    }
    if (hits.length < (input.limit ?? 3)) hits.push({ id: s.row.id, title: s.row.title, category: s.row.category, content: s.row.content, matched: s.matched });
  }
  return { categoryKey: input.categoryKey, categoryName: input.categoryName, needsKnowledge: needsKnowledge(input.categoryKey), hits, skipped };
}

export async function searchKnowledge(
  db: DB,
  input: { brandId: number; body: string; categoryKey: string; categoryName: string; limit?: number },
): Promise<KnowledgeSearchResult> {
  const rows = await all<KnowledgeRow>(
    db,
    `SELECT id, category, title, content, keywords, valid_from, valid_to FROM knowledge_items
     WHERE brand_id = ? AND is_active = 1 AND review_status = 'approved'`,
    [input.brandId],
  );
  return rankKnowledge(rows, input);
}

/** 品牌所有可用知識的內容（送出前檢查金額、日期是否有根據） */
export async function validKnowledgeText(db: DB, brandId: number): Promise<string> {
  const rows = await all<KnowledgeRow>(
    db,
    `SELECT id, category, title, content, keywords, valid_from, valid_to FROM knowledge_items
     WHERE brand_id = ? AND is_active = 1 AND review_status = 'approved'`,
    [brandId],
  );
  return rows
    .filter((r) => validState(r.valid_from, r.valid_to) === 'valid')
    .map((r) => `${r.title}\n${r.content}`)
    .join('\n');
}
