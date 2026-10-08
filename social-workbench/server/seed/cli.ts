// 指令：npm run seed —— 清空資料庫並重新建立示範資料（會使用 DATABASE_URL；未設定時為本機 PGlite）
import { openDb } from '../db';
import { config } from '../config';
import { resetAndSeed } from './index';

const db = await openDb(config.databaseUrl);
const summary = await resetAndSeed(db);
console.log('✅ 示範資料已重新建立：', summary);
await db.close();
