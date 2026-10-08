// Vercel 進入點：所有 /api/* 請求都由這個函式交給 Express 處理。
// 冷啟動時連線資料庫、建立資料表（示範模式下並建立示範資料），之後同一個執行個體重複使用。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Express } from 'express';
import { createApp } from './app';
import { initDatabase } from './init';
import { config } from './config';

let appPromise: Promise<Express> | null = null;

function getApp(): Promise<Express> {
  appPromise ??= initDatabase()
    .then((db) => createApp(db, { serveStatic: false }))
    .catch((err) => {
      appPromise = null;
      throw err;
    });
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const app = await getApp();
    app(req as Parameters<Express>[0], res as Parameters<Express>[1]);
  } catch (err) {
    console.error('初始化失敗', err);
    // 錯誤原因（去掉連線字串，避免洩漏密碼）
    const reason = String((err as Error)?.message ?? err).replace(/postgres(ql)?:\/\/\S+/g, '[連線字串]').slice(0, 300);
    const message = !config.databaseUrlSource
      ? '尚未設定資料庫：Vercel 專案的環境變數中找不到 Postgres 連線字串。請在 Storage 建立 Neon 資料庫並「Connect」到這個專案（三個環境都勾），然後重新部署（Redeploy）。'
      : `已找到資料庫設定（${config.databaseUrlSource}），但連線失敗：${reason}`;
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code: 'init_failed', message } }));
  }
}

