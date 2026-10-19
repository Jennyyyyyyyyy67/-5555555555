// Google 帳號登入（OAuth）：YouTube 頻道與 Google 商家檔案共用同一組 Google Cloud 用戶端。
// 需要的環境變數：GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET（Google Cloud Console「API 和服務 → 憑證 → OAuth 用戶端 ID」）
// 存取權杖只有 1 小時，資料庫只保存長期有效的更新權杖（refresh token），需要時再換新的存取權杖。

export const GOOGLE_SCOPES = {
  /** 讀取影片留言、以頻道身分回覆、審核留言 */
  youtube: ['https://www.googleapis.com/auth/youtube.force-ssl'],
  /** 讀取商家評論、回覆評論 */
  google_business: ['https://www.googleapis.com/auth/business.manage'],
} as const;
export type GoogleTarget = keyof typeof GOOGLE_SCOPES;

export function googleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  return { clientId, clientSecret, configured: !!clientId && !!clientSecret };
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reason?: string,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** 測試用：替換 fetch */
export function setGoogleFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
  tokenCache.clear();
}

interface GoogleErrorBody {
  error?: string | { code?: number; message?: string; status?: string; errors?: Array<{ reason?: string }> };
  error_description?: string;
}

function explain(status: number, body: GoogleErrorBody | null, service: string): GoogleApiError {
  if (typeof body?.error === 'string') {
    if (body.error === 'invalid_grant') {
      return new GoogleApiError('Google 授權已失效或被撤銷，請到「社群帳號」重新連結', status, 'invalid_grant');
    }
    return new GoogleApiError(`Google 登入錯誤：${body.error_description ?? body.error}`, status, body.error);
  }
  const e = body?.error;
  const reason = e?.errors?.[0]?.reason ?? e?.status;
  const raw = e?.message ?? `HTTP ${status}`;
  let msg = `${service} 回應錯誤：${raw}`;
  if (status === 401) msg = 'Google 授權已失效，請到「社群帳號」重新連結';
  else if (reason === 'quotaExceeded' || reason === 'RESOURCE_EXHAUSTED' || status === 429) msg = `${service} 今天的 API 用量已達上限，明天會自動恢復（或到 Google Cloud 申請提高配額）`;
  else if (reason === 'SERVICE_DISABLED' || reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(raw)) msg = `${service} API 尚未在 Google Cloud 專案啟用：${raw}`;
  else if (reason === 'commentsDisabled') msg = '這部影片關閉了留言功能';
  else if (status === 403) msg = `權限不足：${raw}`;
  else if (status === 404) msg = `找不到資料（可能已被刪除）：${raw}`;
  return new GoogleApiError(msg, status, reason);
}

/** 呼叫 Google API；回應空白時傳回 null */
export async function googleCall<T>(url: string, init: RequestInit & { service: string }): Promise<T> {
  const { service, ...rest } = init;
  let res: Response;
  try {
    res = await fetchImpl(url, { ...rest, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new GoogleApiError(`無法連線到 ${service}：${(err as Error).message}`, 0);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw explain(res.status, body as GoogleErrorBody | null, service);
  return body as T;
}

// ---------------- OAuth ----------------
export function authorizeUrl(target: GoogleTarget, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: googleConfig().clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES[target].join(' '),
    // offline + consent 才會拿到可以長期使用的更新權杖
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export async function exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens> {
  const { clientId, clientSecret } = googleConfig();
  const r = await googleCall<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>('https://oauth2.googleapis.com/token', {
    service: 'Google 登入',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  if (!r.refresh_token) throw new GoogleApiError('Google 沒有提供長期授權，請到 Google 帳戶「第三方存取權」移除這個應用程式後再連結一次', 502);
  const tokens = { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: Date.now() + (r.expires_in - 60) * 1000, scopes: (r.scope ?? '').split(' ').filter(Boolean) };
  tokenCache.set(r.refresh_token, { token: r.access_token, expiresAt: tokens.expiresAt });
  return tokens;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** 用更新權杖換取存取權杖（同一個執行環境內會快取到快過期） */
export async function accessTokenFor(refreshToken: string): Promise<string> {
  const hit = tokenCache.get(refreshToken);
  if (hit && hit.expiresAt > Date.now()) return hit.token;
  const { clientId, clientSecret } = googleConfig();
  const r = await googleCall<{ access_token: string; expires_in: number }>('https://oauth2.googleapis.com/token', {
    service: 'Google 登入',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
  });
  tokenCache.set(refreshToken, { token: r.access_token, expiresAt: Date.now() + (r.expires_in - 60) * 1000 });
  return r.access_token;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
