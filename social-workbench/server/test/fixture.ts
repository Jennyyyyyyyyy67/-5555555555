// 測試用的小型固定資料：2 個品牌、4 位人員、每品牌 1 個社群帳號、1 篇貼文、2 則留言。
// 品牌 A：主管 sup、操作人員 opA；品牌 B：操作人員 opB。管理員 admin 可存取全部。
import type { DB } from '../db';
import { insert, run } from '../db';
import { ensureBrandDefaults } from '../db/bootstrap';
import { hashPassword } from '../auth/password';

export const FIXTURE_PASSWORD = 'password123';

export interface Fixture {
  brandA: number;
  brandB: number;
  admin: number;
  sup: number;
  opA: number;
  opB: number;
  accountA: number;
  accountB: number;
  postA: number;
  postB: number;
  commentA: number;
  commentB: number;
}

export const FIXTURE_EMAILS = {
  admin: 'admin@test.tw',
  sup: 'sup@test.tw',
  opA: 'opa@test.tw',
  opB: 'opb@test.tw',
} as const;

export async function seedFixture(db: DB, nowIsoStr = '2026-01-01T00:00:00.000Z'): Promise<Fixture> {
  const now = nowIsoStr;
  const brand = async (name: string, code: string) => {
    const id = await insert(db, 'brands', { name, code, color: '#123456', created_at: now, updated_at: now });
    await ensureBrandDefaults(db, id);
    return id;
  };
  const brandA = await brand('品牌甲', 'BA');
  const brandB = await brand('品牌乙', 'BB');
  const pw = hashPassword(FIXTURE_PASSWORD);
  const user = async (name: string, email: string, role: string, brands: number[]) => {
    const id = await insert(db, 'users', { name, email, role, password_hash: pw, created_at: now, updated_at: now });
    for (const b of brands) await run(db, 'INSERT INTO user_brands (user_id, brand_id, created_at) VALUES (?, ?, ?)', [id, b, now]);
    return id;
  };
  const admin = await user('管理員', FIXTURE_EMAILS.admin, 'admin', []);
  const sup = await user('主管', FIXTURE_EMAILS.sup, 'supervisor', [brandA]);
  const opA = await user('甲操作', FIXTURE_EMAILS.opA, 'operator', [brandA]);
  const opB = await user('乙操作', FIXTURE_EMAILS.opB, 'operator', [brandB]);
  const account = async (brandId: number, ext: string) =>
    await insert(db, 'social_accounts', {
      brand_id: brandId, platform: 'facebook', account_type: 'fb_page', name: `粉專 ${ext}`,
      external_id: ext, adapter_key: 'mock:facebook', created_at: now, updated_at: now,
    });
  const accountA = await account(brandA, 'fx-a');
  const accountB = await account(brandB, 'fx-b');
  const post = async (brandId: number, accountId: number, ext: string) =>
    await insert(db, 'posts', {
      brand_id: brandId, social_account_id: accountId, external_id: ext, content_type: 'post',
      title: `貼文 ${ext}`, body: '內容', published_at: now, created_at: now,
    });
  const postA = await post(brandA, accountA, 'p-a');
  const postB = await post(brandB, accountB, 'p-b');
  const comment = async (brandId: number, accountId: number, postId: number, ext: string, body: string) =>
    await insert(db, 'comments', {
      brand_id: brandId, social_account_id: accountId, post_id: postId, external_id: ext,
      author_name: '顧客', body, occurred_at: now, fetched_at: now, created_at: now, updated_at: now,
    });
  const commentA = await comment(brandA, accountA, postA, 'c-a', '品牌甲的留言');
  const commentB = await comment(brandB, accountB, postB, 'c-b', '品牌乙的留言');
  return { brandA, brandB, admin, sup, opA, opB, accountA, accountB, postA, postB, commentA, commentB };
}
