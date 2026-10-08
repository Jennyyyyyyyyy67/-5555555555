// 測試輔助：建立記憶體資料庫 + 應用程式，並提供以特定帳號登入的 supertest agent。
import request from 'supertest';
import type { Express } from 'express';
import { openDb, resetDatabase, type DB } from '../db';
import { createApp } from '../app';
import { resetAllLoginFailures } from '../auth/rateLimit';
import { FIXTURE_EMAILS, FIXTURE_PASSWORD, seedFixture, type Fixture } from './fixture';

export interface TestContext {
  db: DB;
  app: Express;
  fx: Fixture;
  /** 以 fixture 中的角色登入，回傳帶 cookie 的 agent */
  loginAs: (who: keyof typeof FIXTURE_EMAILS) => Promise<ReturnType<typeof request.agent>>;
  /** 以任意 email / 密碼登入 */
  loginWith: (email: string, password: string) => Promise<ReturnType<typeof request.agent>>;
}

// 每個測試檔共用一個記憶體 PGlite（啟動約需 1～2 秒），每個測試開始前清空重建
let sharedDb: Promise<DB> | null = null;
export function testDb(): Promise<DB> {
  sharedDb ??= openDb(process.env.TEST_DATABASE_URL ?? 'memory:');
  return sharedDb;
}

export async function createTestContext(): Promise<TestContext> {
  resetAllLoginFailures();
  const db = await testDb();
  await resetDatabase(db);
  const fx = await seedFixture(db);
  const app = createApp(db, { serveStatic: false });
  const loginWith = async (email: string, password: string) => {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ email, password });
    if (res.status !== 200) throw new Error(`登入失敗 ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    return agent;
  };
  return {
    db,
    app,
    fx,
    loginWith,
    loginAs: (who) => loginWith(FIXTURE_EMAILS[who], FIXTURE_PASSWORD),
  };
}
