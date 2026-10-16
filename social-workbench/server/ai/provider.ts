// AI 入口：有設定 ANTHROPIC_API_KEY 時用 Claude，否則（或 Claude 暫時無法使用時）用模擬 AI（關鍵字規則）。
import type { DB } from '../db';
import { all } from '../db';
import { mockProvider } from './mockProvider';
import { claudeAnalyze, claudeComposeVariants, claudeConfig, mergeAnalyses, type CategoryOption } from './claude';
import { composeVariants, type ComposedVariant, type ComposeInput } from './compose';
import type { Analysis, AnalyzeInput } from './types';

export interface AiStatus {
  provider: 'claude' | 'mock';
  model: string | null;
}

export function aiStatus(): AiStatus {
  const c = claudeConfig();
  return c.enabled ? { provider: 'claude', model: c.model } : { provider: 'mock', model: null };
}

async function activeCategories(db: DB): Promise<CategoryOption[]> {
  return all<CategoryOption>(db, 'SELECT key, name, description FROM comment_categories WHERE is_active = 1 ORDER BY sort_order, id');
}

/**
 * 判斷一則留言。fast=true 時只用關鍵字規則（例如匯入連結前的大量舊留言，節省時間與費用）。
 * 回傳的 provider 會記錄在 AI 判斷紀錄中，方便追蹤是哪個 AI 判斷的。
 */
export async function analyzeComment(db: DB, input: AnalyzeInput, opts: { fast?: boolean } = {}): Promise<Analysis & { provider: string }> {
  const rules = await mockProvider.analyze(input);
  if (opts.fast || !claudeConfig().enabled) return { ...rules, provider: mockProvider.name };
  try {
    const c = await claudeAnalyze(input, await activeCategories(db));
    return { ...mergeAnalyses(c, rules), provider: `claude:${c.model}` };
  } catch (err) {
    console.warn('[ai] Claude 判斷失敗，改用關鍵字規則：', (err as Error).message);
    return { ...rules, provider: mockProvider.name, reasons: [...rules.reasons, 'AI 暫時無法使用，改用關鍵字規則判斷'] };
  }
}

/** 產生多版本回覆建議：Claude 失敗時改用範本產生（不編造事實） */
export async function composeReplies(input: ComposeInput & { authorName?: string; postContext?: string }): Promise<{ variants: ComposedVariant[]; provider: string }> {
  if (claudeConfig().enabled) {
    try {
      return { variants: await claudeComposeVariants(input), provider: 'claude' };
    } catch (err) {
      console.warn('[ai] Claude 產生回覆失敗，改用範本：', (err as Error).message);
    }
  }
  return { variants: composeVariants(input), provider: 'mock' };
}
