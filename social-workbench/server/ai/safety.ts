// 安全檢查：不可妥協的原則寫在程式裡，不交給 AI 自己判斷。
// 即使規則設定為「AI 自動回覆」，只要符合以下任一條件就一律轉人工。
import type { Analysis } from './types';

/** 自動回覆只開放這些低風險、不需要事實知識的類型（其他類型需要知識庫，階段 3 開放） */
export const AUTO_REPLY_ALLOWED_CATEGORIES = ['praise', 'general'] as const;
/** 這些類型永遠不可自動回覆 */
export const NEVER_AUTO_CATEGORIES = ['complaint', 'negative_review', 'after_sales', 'malicious', 'spam', 'bulk_purchase', 'business_coop'];

export const MIN_AUTO_CONFIDENCE = 0.85;

export interface ForceHumanReason {
  code: string;
  label: string;
}

/** 強制轉人工條件（設定頁會唯讀顯示這份清單） */
export const FORCE_HUMAN_RULES: ForceHumanReason[] = [
  { code: 'low_confidence', label: `AI 信心不足（低於 ${Math.round(MIN_AUTO_CONFIDENCE * 100)}%）` },
  { code: 'knowledge_gap', label: '找不到可靠知識（需要事實資訊的問題）' },
  { code: 'ambiguous', label: '問題內容不明確' },
  { code: 'multi_issue', label: '同時包含多種複雜問題' },
  { code: 'sensitive', label: '涉及敏感議題或安全疑慮' },
  { code: 'complaint', label: '涉及客訴或負面評論' },
  { code: 'refund', label: '涉及退款或補償' },
  { code: 'promise', label: '涉及無法確認的承諾' },
  { code: 'risk', label: '判斷可能具有風險（風險等級中以上、法律或公開爭議）' },
];

const label = (code: string) => FORCE_HUMAN_RULES.find((r) => r.code === code)!.label;

/**
 * 回傳必須轉人工的原因；空陣列代表可以自動回覆。
 * needsKnowledge：此類型的回覆是否需要事實知識（價格、規格…）。第一版沒有知識庫，因此一律視為知識不足。
 */
export function forceHumanReasons(a: Analysis): ForceHumanReason[] {
  const out = new Set<string>();
  if (a.confidence < MIN_AUTO_CONFIDENCE) out.add('low_confidence');
  if (!(AUTO_REPLY_ALLOWED_CATEGORIES as readonly string[]).includes(a.categoryKey)) out.add('knowledge_gap');
  if (a.isAmbiguous) out.add('ambiguous');
  if (a.isMultiIssue) out.add('multi_issue');
  if (a.riskFlags.includes('sensitive') || a.riskFlags.includes('safety') || a.riskFlags.includes('privacy')) out.add('sensitive');
  if (a.riskFlags.includes('complaint') || a.categoryKey === 'complaint' || a.categoryKey === 'negative_review') out.add('complaint');
  if (a.riskFlags.includes('refund') || a.riskFlags.includes('compensation')) out.add('refund');
  if (a.riskFlags.includes('unverifiable_promise')) out.add('promise');
  if (a.riskLevel === 'medium' || a.riskLevel === 'high' || a.riskFlags.includes('legal') || a.riskFlags.includes('public_dispute')) out.add('risk');
  if (a.sentiment === 'negative') out.add('complaint');
  return [...out].map((code) => ({ code, label: label(code) }));
}
