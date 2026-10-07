import { randomUUID } from 'node:crypto';
import type { AccountTypeDef, AdapterAccount, IncomingComment, PlatformAdapter } from '../types';
import { capabilityForAction } from '../types';
import { mockFeed } from './mockFeed';

/**
 * 建立模擬 adapter：
 * - testConnection：externalId 以 "err-" 開頭的帳號模擬連線失敗，其餘成功。
 * - fetchComments：從 mockFeed（模擬器注入的佇列）取出新留言。
 * - replyToComment / performAction：直接回傳成功（平台不支援的動作回傳失敗）。
 */
export function createMockAdapter(def: { platform: string; label: string; accountTypes: AccountTypeDef[] }): PlatformAdapter {
  const typeOf = (account: AdapterAccount) => def.accountTypes.find((t) => t.key === account.accountType);
  return {
    platform: def.platform,
    label: def.label,
    isMock: true,
    accountTypes: def.accountTypes,

    async testConnection(account) {
      if (!typeOf(account)) return { ok: false, message: `${def.label} 不支援此帳號類型` };
      if (account.externalId.startsWith('err-')) {
        return { ok: false, message: `模擬連線失敗：${def.label} 授權已過期，請重新授權（模擬）` };
      }
      return { ok: true, message: `模擬連線成功（${def.label} 尚未串接真實 API）` };
    },

    async fetchComments(account, opts): Promise<IncomingComment[]> {
      const items = mockFeed.drain(account.platform, account.externalId);
      return opts.since ? items.filter((c) => c.occurredAt > opts.since!) : items;
    },

    async replyToComment(account) {
      if (!typeOf(account)?.capabilities.reply) return { ok: false, error: `${def.label} 此帳號類型不支援回覆` };
      return { ok: true, externalReplyId: `mock-reply-${randomUUID()}` };
    },

    async performAction(account, _target, action) {
      const type = typeOf(account);
      if (!type?.capabilities[capabilityForAction(action)]) {
        return { ok: false, error: `${def.label} 不支援此動作` };
      }
      return { ok: true };
    },
  };
}
