// 真實平台串接：Instagram 帳號、Facebook 粉專連結（OAuth）、手動同步、中斷連結、Webhook 即時通知。
import { Router, type Request, type Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { all, get, insert, run, sqlIn, tx, updateById } from '../db';
import { authed, parseCookies, requireAuth, requirePermission } from '../auth/middleware';
import { audit } from '../services/audit';
import { saveCredential } from '../services/credentials';
import { autoSyncLive, safeSync, syncByPlatformUser } from '../services/liveSync';
import { resolveBrandFilter } from '../auth/scope';
import { adapterKeyFor } from '../adapters/registry';
import { badRequest, notFound } from '../lib/errors';
import { nowIso } from '../lib/clock';
import { config } from '../config';
import * as ig from '../integrations/instagram';
import * as fb from '../integrations/facebook';
import { lastInstagramStats } from '../adapters/instagram';
import { lastFacebookStats } from '../adapters/facebook';
import type { InstagramStatus, SyncResult } from '../../shared/types';

const STATE_COOKIE = 'swb_ig_state';
const FB_STATE_COOKIE = 'swb_fb_state';

/** 對外網址：優先使用 PUBLIC_BASE_URL，否則依目前請求的網址 */
export function baseUrl(req: Request): string {
  const fixed = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (fixed) return fixed;
  return `${req.protocol}://${req.get('host')}`;
}
const redirectUri = (req: Request) => `${baseUrl(req)}/api/integrations/instagram/callback`;
const fbRedirectUri = (req: Request) => `${baseUrl(req)}/api/integrations/facebook/callback`;

/** 回到前端的社群帳號頁，帶上結果訊息 */
function backToAccounts(res: Response, params: Record<string, string>): void {
  res.redirect(303, `/settings/accounts?${new URLSearchParams(params)}`);
}

export function integrationRoutes(): Router {
  const r = Router();

  // 設定狀態：前端顯示「連結 Instagram」按鈕、教學要填的網址
  r.get('/instagram', requireAuth(), async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const cfg = ig.instagramConfig();
    const accounts = scope.brandIds.length
      ? await all<{ account_id: number; username: string; token_expires_at: string | null; connected_at: string; brand_name: string; last_synced_at: string | null; status: string }>(
          req.db,
          `SELECT c.account_id, c.username, c.token_expires_at, c.connected_at, b.name AS brand_name, a.last_synced_at, a.status
           FROM account_credentials c JOIN social_accounts a ON a.id = c.account_id JOIN brands b ON b.id = a.brand_id
           WHERE c.provider = 'instagram' AND ${sqlIn('a.brand_id', scope.brandIds)} ORDER BY c.connected_at`,
        )
      : [];
    const body: InstagramStatus = {
      configured: cfg.configured,
      redirectUri: redirectUri(req),
      webhookUrl: `${baseUrl(req)}/api/webhooks/instagram`,
      webhookConfigured: !!cfg.webhookVerifyToken,
      accounts: accounts.map((a) => ({
        accountId: a.account_id,
        username: a.username,
        brandName: a.brand_name,
        tokenExpiresAt: a.token_expires_at,
        connectedAt: a.connected_at,
        lastSyncedAt: a.last_synced_at,
        status: a.status,
      })),
    };
    res.json(body);
  });

  // 開始連結：導向 Instagram 登入頁
  r.get('/instagram/start', requirePermission('manageAccounts'), async (req: Request, res: Response) => {
    const { scope } = authed(req);
    if (!ig.instagramConfig().configured) {
      return backToAccounts(res, { ig_error: '系統尚未設定 INSTAGRAM_APP_ID 與 INSTAGRAM_APP_SECRET，請先依教學在 Vercel 設定環境變數' });
    }
    const brandId = Number(req.query.brandId);
    if (!scope.activeBrandIds.includes(brandId)) return backToAccounts(res, { ig_error: '請選擇要連結到哪個品牌（品牌需為啟用中）' });
    const nonce = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, `${nonce}.${brandId}`, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 10 * 60 * 1000, path: '/api/integrations' });
    res.redirect(302, ig.authorizeUrl(redirectUri(req), nonce));
  });

  // Instagram 授權完成後導回這裡
  r.get('/instagram/callback', requireAuth(), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    res.clearCookie(STATE_COOKIE, { path: '/api/integrations' });
    if (req.query.error) {
      return backToAccounts(res, { ig_error: `Instagram 未授權：${String(req.query.error_description ?? req.query.error_reason ?? req.query.error)}` });
    }
    const [nonce, brandRaw] = (parseCookies(req.headers.cookie)[STATE_COOKIE] ?? '').split('.');
    const brandId = Number(brandRaw);
    if (!nonce || nonce !== String(req.query.state ?? '') || !scope.activeBrandIds.includes(brandId)) {
      return backToAccounts(res, { ig_error: '連結逾時或驗證失敗，請重新按一次「連結 Instagram」' });
    }
    const code = String(req.query.code ?? '').replace(/#_$/, '');
    if (!code) return backToAccounts(res, { ig_error: 'Instagram 沒有回傳授權碼，請再試一次' });

    let token: ig.IgToken;
    let profile: ig.IgProfile;
    try {
      token = await ig.exchangeCode(code, redirectUri(req));
      profile = await ig.getProfile(token.accessToken);
    } catch (err) {
      return backToAccounts(res, { ig_error: (err as Error).message });
    }
    const db = req.db;
    const existing = await get<{ id: number; brand_id: number; brand_name: string }>(
      db,
      "SELECT a.id, a.brand_id, b.name AS brand_name FROM social_accounts a JOIN brands b ON b.id = a.brand_id WHERE a.platform = 'instagram' AND a.external_id = ?",
      [profile.userId],
    );
    if (existing && existing.brand_id !== brandId) {
      return backToAccounts(res, { ig_error: `@${profile.username} 已經連結在「${existing.brand_name}」，同一個帳號不能同時屬於兩個品牌` });
    }
    const now = nowIso();
    const accountId = await tx(db, async () => {
      let id = existing?.id;
      if (id) {
        await updateById(db, 'social_accounts', id, { name: profile.name, handle: `@${profile.username}`, status: 'connected', is_active: true, last_checked_at: now, updated_at: now });
      } else {
        id = await insert(db, 'social_accounts', {
          brand_id: brandId,
          platform: 'instagram',
          account_type: 'ig_account',
          name: profile.name,
          handle: `@${profile.username}`,
          external_id: profile.userId,
          adapter_key: `live:instagram`,
          status: 'connected',
          is_active: true,
          last_checked_at: now,
          created_at: now,
          updated_at: now,
        });
      }
      await saveCredential(db, {
        accountId: id,
        provider: 'instagram',
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
        scopes: token.scopes,
        platformUserId: profile.userId,
        username: profile.username,
        userId: user.id,
      });
      await audit(db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId,
        action: existing ? 'account.reconnect' : 'account.connect',
        targetType: 'social_account',
        targetId: id,
        summary: `${user.name} ${existing ? '重新連結' : '連結'} Instagram 帳號 @${profile.username}`,
        after: { username: profile.username, accountType: profile.accountType, scopes: token.scopes },
      });
      return id;
    });
    const sync = await safeSync(db, accountId);
    backToAccounts(res, { ig: 'connected', username: profile.username, imported: String(sync?.newComments ?? 0) });
  });

  // 中斷連結：刪除權杖（保留帳號與留言紀錄）
  const disconnect = async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    const id = Number(req.params.accountId);
    const acct = await get<{ id: number; brand_id: number; handle: string; name: string; platform: string }>(req.db, 'SELECT id, brand_id, handle, name, platform FROM social_accounts WHERE id = ?', [id]);
    if (!acct || !scope.brandIds.includes(acct.brand_id)) throw notFound('找不到社群帳號');
    const label = acct.platform === 'facebook' ? `Facebook 粉專「${acct.name}」` : `Instagram 帳號 ${acct.handle}`;
    await tx(req.db, async () => {
      await run(req.db, 'DELETE FROM account_credentials WHERE account_id = ?', [id]);
      await run(req.db, "UPDATE social_accounts SET status = 'disconnected', updated_at = ? WHERE id = ?", [nowIso(), id]);
      await audit(req.db, {
        actorType: 'user',
        actorUserId: user.id,
        brandId: acct.brand_id,
        action: 'account.disconnect',
        targetType: 'social_account',
        targetId: id,
        summary: `${user.name} 中斷${label}的連結`,
      });
    });
    res.status(204).end();
  };
  r.post('/instagram/:accountId/disconnect', requirePermission('manageAccounts'), disconnect);
  r.post('/facebook/:accountId/disconnect', requirePermission('manageAccounts'), disconnect);

  // ---------- Facebook 粉絲專頁 ----------
  r.get('/facebook', requireAuth(), async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const accounts = scope.brandIds.length
      ? await all<{ account_id: number; username: string; connected_at: string; brand_name: string; last_synced_at: string | null; status: string }>(
          req.db,
          `SELECT c.account_id, c.username, c.connected_at, b.name AS brand_name, a.last_synced_at, a.status
           FROM account_credentials c JOIN social_accounts a ON a.id = c.account_id JOIN brands b ON b.id = a.brand_id
           WHERE c.provider = 'facebook' AND ${sqlIn('a.brand_id', scope.brandIds)} ORDER BY c.connected_at`,
        )
      : [];
    const body: InstagramStatus = {
      configured: fb.facebookConfig().configured,
      redirectUri: fbRedirectUri(req),
      webhookUrl: '',
      webhookConfigured: false,
      accounts: accounts.map((a) => ({
        accountId: a.account_id,
        username: a.username,
        brandName: a.brand_name,
        tokenExpiresAt: null,
        connectedAt: a.connected_at,
        lastSyncedAt: a.last_synced_at,
        status: a.status,
      })),
    };
    res.json(body);
  });

  r.get('/facebook/start', requirePermission('manageAccounts'), async (req: Request, res: Response) => {
    const { scope } = authed(req);
    if (!fb.facebookConfig().configured) {
      return backToAccounts(res, { fb_error: '系統尚未設定 FACEBOOK_APP_ID 與 FACEBOOK_APP_SECRET，請先依教學在 Vercel 設定環境變數' });
    }
    const brandId = Number(req.query.brandId);
    if (!scope.activeBrandIds.includes(brandId)) return backToAccounts(res, { fb_error: '請選擇要連結到哪個品牌（品牌需為啟用中）' });
    const nonce = randomBytes(16).toString('hex');
    res.cookie(FB_STATE_COOKIE, `${nonce}.${brandId}`, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 10 * 60 * 1000, path: '/api/integrations' });
    res.redirect(302, fb.authorizeUrl(fbRedirectUri(req), nonce));
  });

  // Facebook 授權完成後導回這裡：使用者在 Facebook 畫面勾選的每個粉專都會連結到這個品牌
  r.get('/facebook/callback', requireAuth(), async (req: Request, res: Response) => {
    const { user, scope } = authed(req);
    res.clearCookie(FB_STATE_COOKIE, { path: '/api/integrations' });
    if (req.query.error) {
      return backToAccounts(res, { fb_error: `Facebook 未授權：${String(req.query.error_description ?? req.query.error_reason ?? req.query.error)}` });
    }
    const [nonce, brandRaw] = (parseCookies(req.headers.cookie)[FB_STATE_COOKIE] ?? '').split('.');
    const brandId = Number(brandRaw);
    if (!nonce || nonce !== String(req.query.state ?? '') || !scope.activeBrandIds.includes(brandId)) {
      return backToAccounts(res, { fb_error: '連結逾時或驗證失敗，請重新按一次「連結 Facebook 粉專」' });
    }
    const code = String(req.query.code ?? '');
    if (!code) return backToAccounts(res, { fb_error: 'Facebook 沒有回傳授權碼，請再試一次' });

    let pages: fb.FbPage[];
    try {
      pages = await fb.listPages(await fb.exchangeCode(code, fbRedirectUri(req)));
    } catch (err) {
      return backToAccounts(res, { fb_error: (err as Error).message });
    }
    if (pages.length === 0) {
      return backToAccounts(res, { fb_error: '沒有可以連結的粉專。請確認你是粉專的管理員，並在 Facebook 授權畫面勾選要連結的粉專' });
    }
    const db = req.db;
    const connected: string[] = [];
    const skipped: string[] = [];
    let imported = 0;
    for (const page of pages) {
      const existing = await get<{ id: number; brand_id: number; brand_name: string }>(
        db,
        "SELECT a.id, a.brand_id, b.name AS brand_name FROM social_accounts a JOIN brands b ON b.id = a.brand_id WHERE a.platform = 'facebook' AND a.account_type = 'fb_page' AND a.external_id = ?",
        [page.id],
      );
      if (existing && existing.brand_id !== brandId) {
        skipped.push(`「${page.name}」已連結在「${existing.brand_name}」`);
        continue;
      }
      const now = nowIso();
      const accountId = await tx(db, async () => {
        let id = existing?.id;
        if (id) {
          await updateById(db, 'social_accounts', id, { name: page.name, status: 'connected', is_active: true, last_checked_at: now, updated_at: now });
        } else {
          id = await insert(db, 'social_accounts', {
            brand_id: brandId,
            platform: 'facebook',
            account_type: 'fb_page',
            name: page.name,
            handle: '',
            external_id: page.id,
            adapter_key: 'live:facebook',
            status: 'connected',
            is_active: true,
            last_checked_at: now,
            created_at: now,
            updated_at: now,
          });
        }
        await saveCredential(db, {
          accountId: id,
          provider: 'facebook',
          accessToken: page.accessToken,
          expiresAt: null,
          scopes: fb.FB_SCOPES,
          platformUserId: page.id,
          username: page.name,
          userId: user.id,
        });
        await audit(db, {
          actorType: 'user',
          actorUserId: user.id,
          brandId,
          action: existing ? 'account.reconnect' : 'account.connect',
          targetType: 'social_account',
          targetId: id,
          summary: `${user.name} ${existing ? '重新連結' : '連結'} Facebook 粉專「${page.name}」`,
          after: { pageId: page.id, tasks: page.tasks },
        });
        return id;
      });
      connected.push(page.name);
      imported += (await safeSync(db, accountId))?.newComments ?? 0;
    }
    if (connected.length === 0) return backToAccounts(res, { fb_error: `沒有連結任何粉專：${skipped.join('；')}` });
    backToAccounts(res, { fb: 'connected', pages: connected.join('、'), imported: String(imported), ...(skipped.length ? { fb_skipped: skipped.join('；') } : {}) });
  });

  // 收件匣開著時定期呼叫：同步已連結真實平台、且一段時間沒同步的帳號
  r.post('/auto-sync', requireAuth(), async (req: Request, res: Response) => {
    const { scope } = authed(req);
    res.json(await autoSyncLive(req.db, resolveBrandFilter(scope, req.query.brand).filter((id) => scope.activeBrandIds.includes(id))));
  });

  // 立即同步（任何可處理留言的人都可以）
  r.post('/sync/:accountId', requireAuth(), async (req: Request, res: Response) => {
    const { scope } = authed(req);
    const id = z.coerce.number().int().positive().parse(req.params.accountId);
    const acct = await get<{ brand_id: number; is_active: number }>(req.db, 'SELECT brand_id, is_active FROM social_accounts WHERE id = ?', [id]);
    if (!acct || !scope.activeBrandIds.includes(acct.brand_id)) throw notFound('找不到社群帳號');
    if (acct.is_active !== 1) throw badRequest('帳號已停用，無法同步');
    const { syncAccountDetailed } = await import('../services/pipeline');
    let body: SyncResult;
    try {
      const s = await syncAccountDetailed(req.db, id);
      const st = lastInstagramStats.get(id);
      const fst = lastFacebookStats.get(id);
      const diag = st
        ? `；Instagram 顯示最近 ${st.media} 篇貼文共有 ${st.countedComments} 則留言，API 實際提供 ${st.returnedTopLevel} 則${st.countedComments > st.returnedTopLevel ? '（有留言被 Instagram 隱藏未提供，通常是開發模式只提供測試人員的留言）' : ''}`
        : fst
          ? `；Facebook 顯示最近 ${fst.posts} 篇貼文共有 ${fst.countedComments} 則留言，API 實際提供 ${fst.returned} 則${fst.countedComments > fst.returned ? '（有留言被 Facebook 隱藏未提供：應用程式審查通過前，只提供應用程式管理員、開發者、測試人員的留言）' : ''}`
          : '';
      body = { ok: true, message: `同步完成：新增 ${s.newPosts} 篇貼文、${s.newComments} 則留言，自動回覆 ${s.autoReplied} 則（平台回傳 ${s.fetched} 則留言${s.skippedOwn ? `，其中 ${s.skippedOwn} 則是帳號自己的留言已略過` : ''}${diag}）${s.remaining ? `。還有 ${s.remaining} 則較舊的留言尚未匯入，請再按一次「立即同步」` : ''}`, newPosts: s.newPosts, newComments: s.newComments, autoReplied: s.autoReplied };
    } catch (err) {
      await run(req.db, "UPDATE social_accounts SET status = 'error' WHERE id = ?", [id]);
      body = { ok: false, message: (err as Error).message, newPosts: 0, newComments: 0, autoReplied: 0 };
    }
    res.json(body);
  });

  return r;
}

/** Instagram Webhook（公開網址，不需登入）：Meta 驗證與留言通知 */
export function webhookRoutes(): Router {
  const r = Router();
  r.get('/instagram', (req: Request, res: Response) => {
    const { webhookVerifyToken } = ig.instagramConfig();
    if (req.query['hub.mode'] === 'subscribe' && webhookVerifyToken && req.query['hub.verify_token'] === webhookVerifyToken) {
      res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
      return;
    }
    res.status(403).type('text/plain').send('verify token mismatch');
  });

  r.post('/instagram', async (req: Request, res: Response) => {
    const { appSecret } = ig.instagramConfig();
    const sig = String(req.get('x-hub-signature-256') ?? '');
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
    const expected = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
    if (!appSecret || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      res.status(401).json({ error: { code: 'bad_signature', message: '簽章不正確' } });
      return;
    }
    const body = req.body as { object?: string; entry?: Array<{ id?: string; changes?: Array<{ field?: string }> }> };
    const ids = (body.entry ?? []).filter((e) => (e.changes ?? []).some((c) => c.field === 'comments' || c.field === 'live_comments')).map((e) => String(e.id ?? ''));
    if (ids.length) {
      // Vercel 在回應後會停止執行，因此先同步完再回應（Meta 允許數秒）
      await syncByPlatformUser(req.db, 'instagram', ids);
    }
    res.status(200).json({ ok: true });
  });
  return r;
}
