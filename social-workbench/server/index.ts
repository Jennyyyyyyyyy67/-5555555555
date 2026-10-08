import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app';
import { config } from './config';
import { initDatabase } from './init';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 18)) {
  console.error(`❌ 需要 Node.js 20.18 以上版本（目前為 ${process.versions.node}）。建議安裝 Node.js 24 LTS。`);
  process.exit(1);
}

const db = await initDatabase();
const app = createApp(db);
app.listen(config.port, () => {
  const hasDist = existsSync(join(config.distDir, 'index.html'));
  console.log(`🚀 社群經營工作台 API 已啟動：http://localhost:${config.port}/api`);
  console.log(`   資料庫：${config.databaseUrl.startsWith('pglite:') ? '本機 PGlite（data/pglite）' : '雲端 Postgres'}`);
  if (hasDist) console.log(`   網頁版（建置後）：http://localhost:${config.port}`);
  console.log('   開發模式請開啟：http://localhost:5173');
});
