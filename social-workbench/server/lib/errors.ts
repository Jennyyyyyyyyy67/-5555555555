import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

/** 會直接回傳給前端的錯誤；message 一律使用可給使用者看的繁體中文。 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = '請先登入') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = '你沒有執行此操作的權限') => new HttpError(403, 'forbidden', message);
export const notFound = (message = '找不到資料') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path.join('.') || '';
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: first ? `欄位「${field}」格式不正確：${first.message}` : '資料格式不正確',
        details: err.issues,
      },
    });
    return;
  }
  // SQLite 唯一鍵衝突
  const msg = String((err as Error)?.message ?? '');
  if (msg.includes('UNIQUE constraint failed')) {
    res.status(409).json({ error: { code: 'conflict', message: '資料重複，請確認名稱或代碼是否已存在', details: msg } });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_json', message: '請求內容不是有效的 JSON' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal_error', message: '系統發生錯誤，請稍後再試' } });
};
