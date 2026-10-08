// Vercel 進入點：所有 /api/* 請求都由這個函式交給 Express 處理。
// 冷啟動時連線資料庫、建立資料表（示範模式下並建立示範資料），之後同一個執行個體重複使用。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Express } from 'express';
import { createApp } from './app';
import { initDatabase } from './init';

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
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        error: {
          code: 'init_failed',
          message: '系統無法連線到資料庫，請確認 Vercel 已設定 DATABASE_URL（Postgres 連線字串）',
        },
      }),
    );
  }
}

