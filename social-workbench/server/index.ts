import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db';
import { createApp } from './app';
import { config } from './config';
import { hasAnyUser, resetAndSeed } from './seed';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`❌ 需要 Node.js 22.13 以上版本（目前為 ${process.versions.node}）。建議安裝 Node.js 24 LTS。`);
  process.exit(1);
}

const db = openDb(config.dbPath);

if (!hasAnyUser(db)) {
  if (config.demoMode) {
    const summary = resetAndSeed(db);
    console.log('🌱 資料庫為空，已自動建立示範資料：', summary);
  } else {
    console.warn('⚠️  資料庫沒有任何帳號。請以 DEMO_MODE=true 啟動，或執行 npm run seed 建立示範資料。');
  }
}

const app = createApp(db);
app.listen(config.port, () => {
  const hasDist = existsSync(join(config.distDir, 'index.html'));
  console.log(`🚀 社群經營工作台 API 已啟動：http://localhost:${config.port}/api`);
  if (hasDist) console.log(`   網頁版（建置後）：http://localhost:${config.port}`);
  console.log('   開發模式請開啟：http://localhost:5173');
});
