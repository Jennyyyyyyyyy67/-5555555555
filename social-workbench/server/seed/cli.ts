// 指令：npm run seed —— 清空資料庫並重新建立示範資料
import { openDb } from '../db';
import { config } from '../config';
import { resetAndSeed } from './index';

const db = openDb(config.dbPath);
const summary = resetAndSeed(db);
console.log('✅ 示範資料已重新建立：', summary);
console.log(`   資料庫位置：${config.dbPath}`);
db.close();
