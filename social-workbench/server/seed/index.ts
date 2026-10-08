import type { DB } from '../db';
import { get, resetDatabase, tx } from '../db';
import { seedDemoData, type SeedSummary } from './demoData';
import { mockFeed } from '../adapters/mock/mockFeed';

export type { SeedSummary };

export interface SeedOptions {
  /** 示範資料的「現在」時間（留言時間會以此往前推算）；預設為目前時間 */
  now?: Date;
}

/** 清空整個資料庫並重新建立示範資料 */
export async function resetAndSeed(db: DB, opts: SeedOptions = {}): Promise<SeedSummary> {
  await resetDatabase(db);
  mockFeed.clear();
  return await tx(db, async () => await seedDemoData(db, { now: opts.now ?? new Date() }));
}

export async function hasAnyUser(db: DB): Promise<boolean> {
  const row = await get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM users');
  return (row?.n ?? 0) > 0;
}
