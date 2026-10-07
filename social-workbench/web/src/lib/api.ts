// 前端呼叫 API 的唯一入口。錯誤一律轉成 ApiError（message 為後端回傳的繁體中文訊息）。
import type { ApiErrorBody } from '../../../shared/types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined | Array<string | number>>;

function buildUrl(path: string, query?: Query): string {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  if (!query) return url;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${url}?${qs}` : url;
}

let onUnauthorized: (() => void) | null = null;
/** 由 AuthProvider 設定：任何 API 回傳 401 時呼叫（例如登入逾時） */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network_error', '無法連線到伺服器，請確認網路或伺服器是否啟動');
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/api/auth/login')) onUnauthorized?.();
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `請求失敗（${res.status}）`, err?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** 把任何錯誤轉成可顯示的訊息 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return '發生未預期的錯誤';
}
