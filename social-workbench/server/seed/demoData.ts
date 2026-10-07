// TODO（待實作）：完整示範資料。目前只建立品牌、示範帳號與社群帳號，讓系統可以啟動。
import type { DB } from '../db';
import { insert, run } from '../db';
import { ensureBrandDefaults } from '../db/bootstrap';
import { hashPassword } from '../auth/password';
import { adapterKeyFor } from '../adapters/registry';
import { DEMO_BRANDS, DEMO_PASSWORD, DEMO_USERS } from './demo';

export interface SeedSummary {
  brands: number;
  users: number;
  accounts: number;
  posts: number;
  comments: number;
  replies: number;
}

export function seedDemoData(db: DB, opts: { now: Date }): SeedSummary {
  const now = opts.now.toISOString();
  const brandIds = new Map<string, number>();
  for (const b of DEMO_BRANDS) {
    const id = insert(db, 'brands', { name: b.name, code: b.code, color: b.color, description: b.description, created_at: now, updated_at: now });
    brandIds.set(b.code, id);
    ensureBrandDefaults(db, id);
  }
  const pw = hashPassword(DEMO_PASSWORD);
  for (const u of DEMO_USERS) {
    const id = insert(db, 'users', { name: u.name, email: u.email, password_hash: pw, role: u.role, created_at: now, updated_at: now });
    for (const code of u.brandCodes) run(db, 'INSERT INTO user_brands (user_id, brand_id, created_at) VALUES (?, ?, ?)', [id, brandIds.get(code), now]);
  }
  let accounts = 0;
  for (const [code, brandId] of brandIds) {
    insert(db, 'social_accounts', { brand_id: brandId, platform: 'facebook', account_type: 'fb_page', name: `${code} 粉絲專頁`, external_id: `fb-${code}`, adapter_key: adapterKeyFor('facebook'), created_at: now, updated_at: now });
    accounts++;
  }
  run(db, `INSERT INTO schema_meta (key, value) VALUES ('seeded_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [now]);
  return { brands: brandIds.size, users: DEMO_USERS.length, accounts, posts: 0, comments: 0, replies: 0 };
}
