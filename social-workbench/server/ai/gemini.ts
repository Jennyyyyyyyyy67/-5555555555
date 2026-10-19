// Google Gemini（免費額度）：沒有 Claude 金鑰時，用來產生回覆建議。
// 設定 GEMINI_API_KEY 才會啟用（Google AI Studio 免費申請，不需信用卡）；模型可用 GEMINI_MODEL 指定。
// 免費額度每天的次數有限，用完或呼叫失敗時會自動改用範本回覆。
// 注意：Google 免費方案可能會用送出的內容改善其產品，隱私權政策已說明。

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

export function geminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
  return { enabled: !!apiKey, apiKey, model: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL };
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** 測試用：替換 fetch */
export function setGeminiFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

async function generate(body: unknown, model: string, apiKey: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  } catch {
    return { status: res.status, json: null };
  }
}

function explain(status: number, json: Record<string, unknown> | null): string {
  const msg = (json?.error as { message?: string } | undefined)?.message ?? `HTTP ${status}`;
  if (status === 429) return `Gemini 免費額度已用完，稍後或明天會恢復（${msg}）`;
  if (status === 400 && /API key/i.test(msg)) return 'GEMINI_API_KEY 不正確，請到 Google AI Studio 重新複製金鑰';
  if (status === 404) return `找不到 Gemini 模型「${geminiConfig().model}」，請確認 GEMINI_MODEL 設定（${msg}）`;
  return `Gemini 回應錯誤：${msg}`;
}

/** 呼叫 Gemini 並取得 JSON 結果；平台不接受 JSON Schema 格式時，改在提示詞中要求輸出格式 */
export async function geminiJson(system: string, user: string, schema: Record<string, unknown>, maxTokens: number): Promise<{ data: unknown; model: string }> {
  const { apiKey, model } = geminiConfig();
  const base = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    // 新版模型會先「思考」，預留足夠的輸出長度
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: Math.max(maxTokens * 2, 8192), temperature: 0.7 },
  };
  let r = await generate({ ...base, systemInstruction: { parts: [{ text: system }] }, generationConfig: { ...base.generationConfig, responseJsonSchema: schema } }, model, apiKey);
  if (r.status === 400 && !/API key/i.test(JSON.stringify(r.json ?? ''))) {
    r = await generate({ ...base, systemInstruction: { parts: [{ text: `${system}\n只輸出符合下列 JSON Schema 的 JSON，不要有其他文字：\n${JSON.stringify(schema)}` }] } }, model, apiKey);
  }
  if (r.status !== 200 || !r.json) throw new Error(explain(r.status, r.json));
  const cand = (r.json.candidates as Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }> | undefined)?.[0];
  if (!cand?.content?.parts?.length) throw new Error(`Gemini 沒有產生內容（${cand?.finishReason ?? '原因不明'}）`);
  const text = cand.content.parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return { data: JSON.parse(cleaned), model: String(r.json.modelVersion ?? model) };
  } catch {
    throw new Error(`Gemini 回傳的格式不正確（${cand.finishReason ?? ''}）`);
  }
}
