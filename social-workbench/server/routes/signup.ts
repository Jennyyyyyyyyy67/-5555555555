// 企業自助註冊：建立「企業負責人」帳號與專屬品牌，註冊後直接登入，下一步連結社群帳號。
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { get, insert, run, tx } from '../db';
import { config } from '../config';
import { hashPassword } from '../auth/password';
import { signupRateLimited } from '../auth/rateLimit';
import { createSession, type AuthUser } from '../auth/session';
import { computeScope } from '../auth/scope';
import { ensureBrandDefaults } from '../db/bootstrap';
import { audit } from '../services/audit';
import { conflict, HttpError } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { PASSWORD_MIN_LENGTH } from '../../shared/constants';
import type { AuthConfigResponse, SignupInput } from '../../shared/types';
import { buildMe, setSessionCookie } from './auth';

const COLORS = ['#3355d6', '#7b4fe0', '#0e7490', '#15803d', '#b45309', '#d93a3a', '#be185d'];

const signupSchema = z.object({
  companyName: z.string().trim().min(1, '請輸入公司或品牌名稱').max(40, '名稱最多 40 個字'),
  name: z.string().trim().min(1, '請輸入你的名字').max(40, '名字最多 40 個字'),
  email: z.string().trim().toLowerCase().email('Email 格式不正確').max(200),
  password: z.string().min(PASSWORD_MIN_LENGTH, `密碼至少 ${PASSWORD_MIN_LENGTH} 個字`).max(200),
});


async function uniqueCode(db: Parameters<typeof get>[0]): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    if (!(await get(db, 'SELECT id FROM brands WHERE upper(code) = ?', [code]))) return code;
  }
  throw new HttpError(500, 'code_failed', '建立品牌代碼失敗，請再試一次');
}

export function signupRoutes(): Router {
  const r = Router();

  r.get('/config', (_req: Request, res: Response) => {
    res.json({ signupEnabled: config.allowSignup, demoMode: config.demoMode } satisfies AuthConfigResponse);
  });

  r.post('/signup', async (req: Request, res: Response) => {
    if (!config.allowSignup) throw new HttpError(403, 'signup_disabled', '目前未開放註冊，請聯絡系統管理員');
    if (await signupRateLimited(req.db, req.ip ?? 'unknown')) throw new HttpError(429, 'too_many_signups', '註冊次數過多，請稍後再試');
    const input: SignupInput = signupSchema.parse(req.body);
    const db = req.db;
    if (await get(db, 'SELECT id FROM users WHERE lower(email) = lower(?)', [input.email])) {
      throw conflict('這個 Email 已經註冊過了，請直接登入', { field: 'email' });
    }
    if (await get(db, 'SELECT id FROM brands WHERE lower(name) = lower(?)', [input.companyName])) {
      throw conflict('這個公司／品牌名稱已經有人使用，請換一個名稱（例如加上地區或英文名）', { field: 'companyName' });
    }
    const now = nowIso();
    const { userId, brandId } = await tx(db, async () => {
      const brandId = await insert(db, 'brands', {
        name: input.companyName,
        code: await uniqueCode(db),
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        description: '自助註冊建立',
        created_at: now,
        updated_at: now,
      });
      const userId = await insert(db, 'users', {
        name: input.name,
        email: input.email,
        password_hash: hashPassword(input.password),
        role: 'owner',
        last_login_at: now,
        created_at: now,
        updated_at: now,
      });
      await ensureBrandDefaults(db, brandId, userId);
      await run(db, 'INSERT INTO user_brands (user_id, brand_id, created_at) VALUES (?, ?, ?)', [userId, brandId, now]);
      // 預設回覆風格：親切、少量表情，署名用公司名稱（之後可在「AI 回覆風格」修改）
      await run(
        db,
        `UPDATE brand_styles SET personality = ?, tone = ?, addressing = '您', emoji_usage = 'light', reply_length = 'medium', signature = ?, updated_by_id = ?, updated_at = ? WHERE brand_id = ?`,
        [`${input.companyName}的社群小編，親切、真誠。`, '親切、真誠', input.companyName, userId, now, brandId],
      );
      await audit(db, {
        actorType: 'user',
        actorUserId: userId,
        brandId,
        action: 'auth.signup',
        targetType: 'brand',
        targetId: brandId,
        summary: `${input.name} 註冊並建立「${input.companyName}」`,
        detail: { email: input.email },
      });
      return { userId, brandId };
    });
    const user: AuthUser = { id: userId, name: input.name, email: input.email, role: 'owner', isActive: true };
    const session = await createSession(db, userId);
    setSessionCookie(res, session.token, session.expiresAt);
    res.status(201).json({ ...(await buildMe(db, user, await computeScope(db, user))), brandId });
  });

  return r;
}
