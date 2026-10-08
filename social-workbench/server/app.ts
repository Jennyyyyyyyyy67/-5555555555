import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db';
import { loadUser } from './auth/middleware';
import { apiRouter } from './routes';
import { errorHandler, notFound } from './lib/errors';
import { config } from './config';

export interface AppOptions {
  /** 是否提供前端建置後的靜態檔（dist/）；預設為 dist/index.html 存在時提供 */
  serveStatic?: boolean;
}

export function createApp(db: DB, opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.onVercel ? true : 'loopback');

  app.use((req, res, next) => {
    req.db = db;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use('/api', express.json({ limit: '1mb' }), (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', loadUser(), apiRouter());
  app.use('/api', (_req, _res, next) => next(notFound('找不到此 API')));

  const indexHtml = join(config.distDir, 'index.html');
  const serveStatic = opts.serveStatic ?? existsSync(indexHtml);
  if (serveStatic) {
    app.use(express.static(config.distDir, { index: false }));
    // 單頁應用：非 API 的 GET 一律回傳 index.html，交給前端路由
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(indexHtml);
    });
  }

  app.use(errorHandler);
  return app;
}
