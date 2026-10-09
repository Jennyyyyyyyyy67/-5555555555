// AI 介面：第一版使用模擬 AI（關鍵字規則，不需金鑰、結果可預期），日後可替換成 Claude API。
// 不可妥協的原則不交給 AI 自己判斷，而是由 safety.ts 的安全檢查強制執行。
import type { Priority, RiskFlag, RiskLevel, Sentiment } from '../../shared/constants';

export interface AnalyzeInput {
  body: string;
  authorName: string;
  rating: number | null;
  platform: string;
  brandCode: string;
}

export interface Analysis {
  categoryKey: string;
  /** 輔助標籤（繁體中文） */
  tags: string[];
  riskFlags: RiskFlag[];
  riskLevel: RiskLevel;
  sentiment: Sentiment;
  priority: Priority;
  /** 0～1，AI 對分類的把握 */
  confidence: number;
  /** 問題內容不明確 */
  isAmbiguous: boolean;
  /** 同時包含多種問題 */
  isMultiIssue: boolean;
  /** 判斷依據（給人看） */
  reasons: string[];
}

export interface BrandStyle {
  addressing: string;
  emojiUsage: 'none' | 'light' | 'frequent';
  replyLength: 'short' | 'medium' | 'long';
  signature: string;
  commonPhrases: string[];
  bannedWords: string[];
}

export interface GenerateInput {
  body: string;
  authorName: string;
  categoryKey: string;
  brandName: string;
  style: BrandStyle;
  /** 用來讓相似留言收到不同措辭 */
  seed: number;
}

export interface AIProvider {
  readonly name: string;
  analyze(input: AnalyzeInput): Promise<Analysis>;
  /** 產生不需要事實知識的低風險回覆（稱讚、一般互動） */
  generateSimpleReply(input: GenerateInput): Promise<string>;
}
