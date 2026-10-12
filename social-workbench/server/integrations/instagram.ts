// Instagram API（Instagram 登入）串接：OAuth 授權、讀取貼文與留言、回覆、隱藏、刪除。
// 官方文件：https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
// 需要的環境變數：INSTAGRAM_APP_ID、INSTAGRAM_APP_SECRET（Meta 開發者後台「Instagram 登入的 API 設定」中的 Instagram 應用程式編號與密鑰）

export const IG_GRAPH = 'https://graph.instagram.com';
export const IG_API_VERSION = 'v23.0';
export const IG_SCOPES = ['instagram_business_basic', 'instagram_business_manage_comments'];

export function instagramConfig() {
  const appId = process.env.INSTAGRAM_APP_ID?.trim() ?? '';
  const appSecret = process.env.INSTAGRAM_APP_SECRET?.trim() ?? '';
  return {
    appId,
    appSecret,
    configured: !!appId && !!appSecret,
    /** Webhook 驗證權杖（在 Meta 後台設定 Webhook 時填入相同的字串） */
    webhookVerifyToken: process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN?.trim() || '',
  };
}

export class InstagramApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
  ) {
    super(message);
  }
}

/** 把 Instagram 的錯誤轉成看得懂的中文 */
function explain(status: number, body: { error?: { message?: string; code?: number; error_subcode?: number } } | null): InstagramApiError {
  const e = body?.error;
  const raw = e?.message ?? `HTTP ${status}`;
  let msg = `Instagram 回應錯誤：${raw}`;
  if (e?.code === 190) msg = 'Instagram 授權已失效或過期，請到「社群帳號」重新連結 Instagram';
  else if (e?.code === 10 || e?.code === 200) msg = `權限不足：${raw}（請確認連結時有勾選留言管理權限）`;
  else if (e?.code === 4 || e?.code === 17 || e?.code === 32 || e?.code === 613) msg = 'Instagram API 呼叫次數超過限制，請稍後再試';
  else if (e?.code === 100 && /comment/i.test(raw)) msg = `找不到這則留言或無法對它操作（可能已被刪除）：${raw}`;
  return new InstagramApiError(msg, status, e?.code);
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** 測試用：替換 fetch */
export function setInstagramFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new InstagramApiError(`無法連線到 Instagram：${(err as Error).message}`, 0);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw explain(res.status, body as never);
  return body as T;
}

const graph = (path: string, params: Record<string, string>) => `${IG_GRAPH}/${IG_API_VERSION}/${path}?${new URLSearchParams(params)}`;

// ---------------- OAuth ----------------
export function authorizeUrl(redirectUri: string, state: string): string {
  const { appId } = instagramConfig();
  const p = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: IG_SCOPES.join(','),
    state,
    enable_fb_login: '0',
    force_authentication: '1',
  });
  return `https://www.instagram.com/oauth/authorize?${p}`;
}

export interface IgToken {
  accessToken: string;
  /** ISO 時間；null 代表平台沒有提供 */
  expiresAt: string | null;
  userId: string;
  scopes: string[];
}

/** 用授權碼換取長效權杖（約 60 天） */
export async function exchangeCode(code: string, redirectUri: string): Promise<IgToken> {
  const { appId, appSecret } = instagramConfig();
  const form = new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code });
  type Short = { access_token: string; user_id: number | string; permissions?: string[] | string };
  const raw = await call<Short | { data: Short[] }>('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const short = 'data' in raw ? raw.data[0] : raw;
  if (!short?.access_token) throw new InstagramApiError('Instagram 沒有回傳存取權杖', 502);
  const long = await call<{ access_token: string; expires_in?: number }>(
    `${IG_GRAPH}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: appSecret, access_token: short.access_token })}`,
  );
  const perms = Array.isArray(short.permissions) ? short.permissions : typeof short.permissions === 'string' ? short.permissions.split(',') : IG_SCOPES;
  return {
    accessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null,
    userId: String(short.user_id),
    scopes: perms,
  };
}

/** 延長長效權杖（權杖需已超過 24 小時且尚未過期） */
export async function refreshToken(accessToken: string): Promise<{ accessToken: string; expiresAt: string | null }> {
  const r = await call<{ access_token: string; expires_in?: number }>(
    `${IG_GRAPH}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: accessToken })}`,
  );
  return { accessToken: r.access_token, expiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000).toISOString() : null };
}

// ---------------- 資料 ----------------
export interface IgProfile {
  userId: string;
  username: string;
  name: string;
  accountType: string;
}

export async function getProfile(token: string): Promise<IgProfile> {
  const r = await call<{ id: string; user_id?: string; username: string; name?: string; account_type?: string }>(
    graph('me', { fields: 'user_id,username,name,account_type', access_token: token }),
  );
  return { userId: String(r.user_id ?? r.id), username: r.username, name: r.name || r.username, accountType: r.account_type ?? '' };
}

export interface IgMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp: string;
}

export async function listMedia(token: string, limit = 10): Promise<IgMedia[]> {
  const r = await call<{ data: IgMedia[] }>(
    graph('me/media', { fields: 'id,caption,media_type,media_product_type,permalink,timestamp', limit: String(limit), access_token: token }),
  );
  return r.data ?? [];
}

export interface IgComment {
  id: string;
  text?: string;
  timestamp: string;
  username?: string;
  from?: { id: string; username?: string };
  like_count?: number;
  parent_id?: string;
  replies?: { data: IgComment[] };
}

export async function listComments(token: string, mediaId: string): Promise<IgComment[]> {
  const fields = 'id,text,timestamp,username,from,like_count,replies{id,text,timestamp,username,from,parent_id}';
  const r = await call<{ data: IgComment[] }>(graph(`${mediaId}/comments`, { fields, limit: '50', access_token: token }));
  return r.data ?? [];
}

export async function replyToComment(token: string, commentId: string, message: string): Promise<string> {
  const r = await call<{ id: string }>(`${IG_GRAPH}/${IG_API_VERSION}/${commentId}/replies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message, access_token: token }),
  });
  return r.id;
}

export async function setHidden(token: string, commentId: string, hide: boolean): Promise<void> {
  await call(`${IG_GRAPH}/${IG_API_VERSION}/${commentId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ hide: String(hide), access_token: token }),
  });
}

export async function deleteComment(token: string, commentId: string): Promise<void> {
  await call(graph(commentId, { access_token: token }), { method: 'DELETE' });
}
