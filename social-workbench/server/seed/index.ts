import type { DB } from '../db';
import { resetDatabase, tx } from '../db';
import { seedDemoData, type SeedSummary } from './demoData';
import { mockFeed } from '../adapters/mock/mockFeed';

export type { SeedSummary };

export interface SeedOptions {
  /** 示範資料的「現在」時間（留言時間會以此往前推算）；預設為目前時間 */
  now?: Date;
}

/** 清空整個資料庫並重新建立示範資料 */
export function resetAndSeed(db: DB, opts: SeedOptions = {}): SeedSummary {
  resetDatabase(db);
  mockFeed.clear();
  return tx(db, () => seedDemoData(db, { now: opts.now ?? new Date() }));
}

export function hasAnyUser(db: DB): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n > 0;
}
