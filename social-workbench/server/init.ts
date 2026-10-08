import { get, openDb, run, tx, type DB } from './db';
import { config } from './config';
import { resetAndSeed } from './seed';

/**
 * 開啟資料庫、建立資料表，並在示範模式下於資料庫為空時建立示範資料。
 * 用 advisory lock 確保多個執行個體（例如 Vercel 同時冷啟動）不會重複建立。
 */
export async function initDatabase(): Promise<DB> {
  const db = await openDb(config.databaseUrl);
  if (config.demoMode) {
    await tx(db, async () => {
      await run(db, 'SELECT pg_advisory_xact_lock(724502)');
      const row = await get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM users');
      if ((row?.n ?? 0) === 0) {
        const summary = await resetAndSeed(db);
        console.log('🌱 資料庫為空，已自動建立示範資料：', summary);
      }
    });
  } else {
    const row = await get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM users');
    if ((row?.n ?? 0) === 0) console.warn('⚠️  資料庫沒有任何帳號。請以 DEMO_MODE=true 啟動，或執行 npm run seed 建立示範資料。');
  }
  return db;
}
