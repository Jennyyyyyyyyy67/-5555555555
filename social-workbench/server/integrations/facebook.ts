// Facebook 粉絲專頁串接（Facebook 登入）：OAuth 授權、取得粉專、讀取貼文與留言、回覆、按讚、隱藏、刪除。
// 官方文件：https://developers.facebook.com/docs/pages-api
// 需要的環境變數：FACEBOOK_APP_ID、FACEBOOK_APP_SECRET（Meta 開發者後台「應用程式設定 → 基本資料」的應用程式編號與密鑰）

export const FB_GRAPH = 'https://graph.facebook.com';
export const FB_API_VERSION = 'v23.0';
/** 讀取粉專貼文與留言、以粉專身分回覆／隱藏／刪除／按讚 */
export const FB_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement'];

export function facebookConfig() {
  const appId = process.env.FACEBOOK_APP_ID?.trim() ?? '';
  const appSecret = process.env.FACEBOOK_APP_SECRET?.trim() ?? '';
  return { appId, appSecret, configured: !!appId && !!appSecret };
}

export class FacebookApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
  ) {
    super(message);
  }
}

function explain(status: number, body: { error?: { message?: string; code?: number } } | null): FacebookApiError {
  const e = body?.error;
  const raw = e?.message ?? `HTTP ${status}`;
  let msg = `Facebook 回應錯誤：${raw}`;
  if (e?.code === 190) msg = 'Facebook 授權已失效（可能改了密碼或移除了應用程式），請到「社群帳號」重新連結 Facebook 粉專';
  else if (e?.code === 10 || e?.code === 200 || (e?.code && e.code >= 200 && e.code < 300)) msg = `權限不足：${raw}（請確認連結時有勾選該粉專並允許所有權限）`;
  else if (e?.code === 4 || e?.code === 17 || e?.code === 32 || e?.code === 613) msg = 'Facebook API 呼叫次數超過限制，請稍後再試';
  return new FacebookApiError(msg, status, e?.code);
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** 測試用：替換 fetch */
export function setFacebookFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new FacebookApiError(`無法連線到 Facebook：${(err as Error).message}`, 0);
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

const graph = (path: string, params: Record<string, string>) => `${FB_GRAPH}/${FB_API_VERSION}/${path}?${new URLSearchParams(params)}`;
const post = (path: string, params: Record<string, string>) =>
  call<Record<string, unknown>>(`${FB_GRAPH}/${FB_API_VERSION}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });

// ---------------- OAuth ----------------
export function authorizeUrl(redirectUri: string, state: string): string {
  const { appId } = facebookConfig();
  const p = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, response_type: 'code', scope: FB_SCOPES.join(','), state });
  return `https://www.facebook.com/${FB_API_VERSION}/dialog/oauth?${p}`;
}

/** 用授權碼換取長效使用者權杖（約 60 天；由它取得的粉專權杖不會過期） */
export async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const { appId, appSecret } = facebookConfig();
  const short = await call<{ access_token: string }>(graph('oauth/access_token', { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code }));
  if (!short?.access_token) throw new FacebookApiError('Facebook 沒有回傳存取權杖', 502);
  const long = await call<{ access_token: string }>(
    graph('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token }),
  );
  return long.access_token;
}

export interface FbPage {
  id: string;
  name: string;
  accessToken: string;
  tasks: string[];
}

/** 使用者在授權畫面勾選、而且有管理權限的粉專 */
export async function listPages(userToken: string): Promise<FbPage[]> {
  const r = await call<{ data?: Array<{ id: string; name: string; access_token?: string; tasks?: string[] }> }>(
    graph('me/accounts', { fields: 'id,name,access_token,tasks', limit: '100', access_token: userToken }),
  );
  return (r.data ?? []).filter((p) => p.access_token).map((p) => ({ id: p.id, name: p.name, accessToken: p.access_token!, tasks: p.tasks ?? [] }));
}

// ---------------- 資料 ----------------
export interface FbPost {
  id: string;
  message?: string;
  created_time: string;
  permalink_url?: string;
}

export async function listPosts(pageToken: string, pageId: string, limit = 25): Promise<FbPost[]> {
  const r = await call<{ data?: FbPost[] }>(graph(`${pageId}/posts`, { fields: 'id,message,created_time,permalink_url', limit: String(limit), access_token: pageToken }));
  return r.data ?? [];
}

export interface FbComment {
  id: string;
  message?: string;
  created_time: string;
  from?: { id: string; name?: string };
  parent?: { id: string };
  like_count?: number;
}

/** 貼文的所有留言（含回覆，filter=stream 會攤平成一個清單並附上 parent），最多 10 頁 */
export async function listComments(pageToken: string, postId: string, maxPages = 10): Promise<{ data: FbComment[]; complete: boolean }> {
  let url: string | undefined = graph(`${postId}/comments`, {
    filter: 'stream',
    order: 'chronological',
    fields: 'id,message,created_time,from{id,name},parent{id},like_count',
    limit: '100',
    access_token: pageToken,
  });
  const data: FbComment[] = [];
  for (let page = 0; url && page < maxPages; page++) {
    const r: { data?: FbComment[]; paging?: { next?: string } } = await call(url);
    data.push(...(r.data ?? []));
    url = r.paging?.next;
  }
  return { data, complete: !url };
}

export async function replyToComment(pageToken: string, commentId: string, message: string): Promise<string> {
  const r = await post(`${commentId}/comments`, { message, access_token: pageToken });
  return String(r.id ?? '');
}

export async function setHidden(pageToken: string, commentId: string, hide: boolean): Promise<void> {
  await post(commentId, { is_hidden: String(hide), access_token: pageToken });
}

export async function setLiked(pageToken: string, commentId: string, like: boolean): Promise<void> {
  if (like) await post(`${commentId}/likes`, { access_token: pageToken });
  else await call(graph(`${commentId}/likes`, { access_token: pageToken }), { method: 'DELETE' });
}

export async function deleteComment(pageToken: string, commentId: string): Promise<void> {
  await call(graph(commentId, { access_token: pageToken }), { method: 'DELETE' });
}
