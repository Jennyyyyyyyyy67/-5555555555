import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 3001),
  dbPath: process.env.DB_PATH ?? `${root}data/workbench.db`,
  distDir: `${root}dist`,
  /** 示範模式：資料庫為空時自動建立示範資料，並在登入頁顯示示範帳號 */
  demoMode: (process.env.DEMO_MODE ?? 'true') !== 'false',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  isProduction: process.env.NODE_ENV === 'production',
};

export const SESSION_COOKIE = 'swb_session';
