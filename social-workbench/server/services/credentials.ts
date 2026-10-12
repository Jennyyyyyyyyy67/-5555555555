// 帳號授權：讀取／儲存真實平台的存取權杖，並組出 adapter 需要的帳號資訊。
import type { DB } from '../db';
import { get, run } from '../db';
import { nowIso } from '../lib/clock';
import type { AdapterAccount } from '../adapters/types';
import { decryptSecret, encryptSecret } from '../integrations/secret';
import { refreshToken } from '../integrations/instagram';

interface CredRow {
  account_id: number;
  provider: string;
  access_token_enc: string;
  token_expires_at: string | null;
  platform_user_id: string;
  username: string;
  connected_at: string;
  updated_at: string;
}

export interface Credential {
  provider: string;
  accessToken: string;
  expiresAt: string | null;
  platformUserId: string;
  username: string;
  connectedAt: string;
}

const DAY = 86_400_000;

export async function saveCredential(
  db: DB,
  input: { accountId: number; provider: string; accessToken: string; expiresAt: string | null; scopes: string[]; platformUserId: string; username: string; userId: number },
): Promise<void> {
  const now = nowIso();
  await run(
    db,
    `INSERT INTO account_credentials (account_id, provider, access_token_enc, token_expires_at, scopes, platform_user_id, username, connected_by_id, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET provider = excluded.provider, access_token_enc = excluded.access_token_enc,
       token_expires_at = excluded.token_expires_at, scopes = excluded.scopes, platform_user_id = excluded.platform_user_id,
       username = excluded.username, connected_by_id = excluded.connected_by_id, updated_at = excluded.updated_at`,
    [input.accountId, input.provider, encryptSecret(input.accessToken), input.expiresAt, JSON.stringify(input.scopes), input.platformUserId, input.username, input.userId, now, now],
  );
}

/** 讀取權杖；快到期（10 天內）且已超過 1 天時自動延長 */
export async function loadCredential(db: DB, accountId: number): Promise<Credential | null> {
  const row = await get<CredRow>(db, 'SELECT * FROM account_credentials WHERE account_id = ?', [accountId]);
  if (!row) return null;
  let token: string;
  try {
    token = decryptSecret(row.access_token_enc);
  } catch {
    return null;
  }
  let expiresAt = row.token_expires_at;
  if (row.provider === 'instagram' && expiresAt && Date.parse(expiresAt) - Date.now() < 10 * DAY && Date.now() - Date.parse(row.updated_at) > DAY) {
    try {
      const r = await refreshToken(token);
      token = r.accessToken;
      expiresAt = r.expiresAt;
      await run(db, 'UPDATE account_credentials SET access_token_enc = ?, token_expires_at = ?, updated_at = ? WHERE account_id = ?', [
        encryptSecret(token),
        expiresAt,
        nowIso(),
        accountId,
      ]);
    } catch (err) {
      console.warn('[credentials] 延長 Instagram 權杖失敗', (err as Error).message);
    }
  }
  return { provider: row.provider, accessToken: token, expiresAt, platformUserId: row.platform_user_id, username: row.username, connectedAt: row.connected_at };
}

/** 依帳號資料組出 adapter 用的帳號資訊（含權杖） */
export async function adapterAccountFor(
  db: DB,
  a: { id: number; brand_id: number; platform: string; account_type: string; external_id: string; name: string },
): Promise<AdapterAccount> {
  const cred = await loadCredential(db, a.id);
  return { id: a.id, brandId: a.brand_id, platform: a.platform, accountType: a.account_type, externalId: a.external_id, name: a.name, accessToken: cred?.accessToken ?? null };
}
