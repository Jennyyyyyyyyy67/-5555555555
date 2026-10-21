import { createHash } from 'node:crypto';
import { get, openDb, run, tx, type DB } from './db';
import { config } from './config';
import { resetAndSeed } from './seed';
import { hashPassword } from './auth/password';
import { audit } from './services/audit';
import { nowIso } from './lib/clock';

/**
 * 忘記管理員密碼時的救援：在環境變數設定 ADMIN_RESET_PASSWORD（至少 8 碼），
 * 啟動時會把 ADMIN_RESET_EMAIL（預設 admin@demo.tw）的密碼改成它，並重新啟用帳號。
 * 登入後請到 Vercel 刪除這個環境變數，再自行設定新密碼。
 */
export async function applyAdminPasswordReset(db: DB, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const password = env.ADMIN_RESET_PASSWORD?.trim();
  if (!password) return false;
  if (password.length < 8) {
    console.warn('⚠️  ADMIN_RESET_PASSWORD 至少要 8 個字元，這次沒有重設密碼');
    return false;
  }
  const email = (env.ADMIN_RESET_EMAIL?.trim() || 'admin@demo.tw').toLowerCase();
  // 同一組救援密碼只套用一次：之後改過的密碼或停用狀態，不會在每次冷啟動時被蓋回去
  const marker = createHash('sha256').update(`${email}\n${password}`).digest('hex');
  const applied = await get<{ value: string }>(db, "SELECT value FROM schema_meta WHERE key = 'admin_reset_applied'");
  if (applied?.value === marker) return false;
  const user = await get<{ id: number; name: string }>(db, "SELECT id, name FROM users WHERE lower(email) = ? AND role = 'admin'", [email]);
  if (!user) {
    console.warn(`⚠️  找不到管理員帳號 ${email}，沒有重設密碼`);
    return false;
  }
  await run(db, 'UPDATE users SET password_hash = ?, is_active = 1, updated_at = ? WHERE id = ?', [hashPassword(password), nowIso(), user.id]);
  await run(db, "INSERT INTO schema_meta (key, value) VALUES ('admin_reset_applied', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [marker]);
  await audit(db, {
    actorType: 'system',
    action: 'user.reset_password',
    targetType: 'user',
    targetId: user.id,
    summary: `依環境變數 ADMIN_RESET_PASSWORD 重設管理員「${user.name}」的密碼`,
  });
  console.warn(`🔑 已依 ADMIN_RESET_PASSWORD 重設 ${email} 的密碼。登入後請刪除這個環境變數。`);
  return true;
}

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
  await applyAdminPasswordReset(db).catch((err) => console.warn('重設管理員密碼失敗：', (err as Error).message));
  return db;
}
