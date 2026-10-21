// 存取權杖加密（AES-256-GCM）。金鑰來自 TOKEN_SECRET；未設定時改用 INSTAGRAM_APP_SECRET。
// 解密時依序嘗試所有候選金鑰，之後新增 TOKEN_SECRET 也不會讓已連結的帳號失效（下次更新權杖時會改用新金鑰）。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const DEV_SECRET = 'local-dev-only-secret';
const derive = (secret: string) => createHash('sha256').update(secret).digest();

function candidates(): string[] {
  return [process.env.TOKEN_SECRET, process.env.INSTAGRAM_APP_SECRET, DEV_SECRET].filter((s): s is string => !!s);
}

function encryptionKey(): Buffer {
  const secret = candidates()[0];
  // 正式網站不可用程式碼裡公開的開發用金鑰加密
  if (secret === DEV_SECRET && process.env.VERCEL) throw new Error('尚未設定 TOKEN_SECRET，無法安全保存平台權杖。請在 Vercel 環境變數新增 TOKEN_SECRET（隨機長字串）後重新部署。');
  return derive(secret);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
  const [v, iv, tag, data] = payload.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('權杖格式不正確');
  let lastError: unknown;
  for (const secret of candidates()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', derive(secret), Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
