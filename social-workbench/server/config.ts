import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const onVercel = !!process.env.VERCEL;

export const config = {
  port: Number(process.env.PORT ?? 3001),
  /**
   * 資料庫連線：
   * - 雲端（Vercel）：DATABASE_URL 或 POSTGRES_URL（Neon / Vercel Postgres 會自動提供）
   * - 本機：未設定時使用 PGlite，資料存在 data/pglite 資料夾
   */
  databaseUrl: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? `pglite:${root}data/pglite`,
  distDir: `${root}dist`,
  /** 示範模式：資料庫為空時自動建立示範資料，並在登入頁顯示示範帳號 */
  demoMode: (process.env.DEMO_MODE ?? 'true') !== 'false',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  /** 部署在 Vercel（HTTPS）時自動使用安全 cookie */
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : onVercel,
  onVercel,
  isProduction: process.env.NODE_ENV === 'production',
};

export const SESSION_COOKIE = 'swb_session';
