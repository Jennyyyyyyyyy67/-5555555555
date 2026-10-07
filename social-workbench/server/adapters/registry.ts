import type { PlatformAdapter } from './types';
import { createMockAdapter } from './mock/createMockAdapter';
import type { PlatformMeta } from '../../shared/types';

// 各平台的帳號類型與可用動作。能力設定參考各平台公開 API 的實際限制：
// - Instagram API 不支援對留言按讚、不支援封鎖。
// - YouTube 的「隱藏」對應「保留待審」，封鎖對應「封鎖作者」，API 不支援對留言按讚。
// - Google 商家評論只能回覆，無法隱藏或刪除顧客評論。
const facebook = createMockAdapter({
  platform: 'facebook',
  label: 'Facebook',
  accountTypes: [
    {
      key: 'fb_page',
      label: 'Facebook 粉絲專頁',
      contentTypes: ['post', 'ad'],
      capabilities: { reply: true, like: true, hide: true, delete: true, block: true },
    },
    {
      key: 'fb_group',
      label: 'Facebook 社團',
      contentTypes: ['group_post'],
      capabilities: { reply: true, like: true, hide: false, delete: true, block: true },
    },
  ],
});

const instagram = createMockAdapter({
  platform: 'instagram',
  label: 'Instagram',
  accountTypes: [
    {
      key: 'ig_account',
      label: 'Instagram 帳號',
      contentTypes: ['post', 'reel', 'ad'],
      capabilities: { reply: true, like: false, hide: true, delete: true, block: false },
    },
  ],
});

const youtube = createMockAdapter({
  platform: 'youtube',
  label: 'YouTube',
  accountTypes: [
    {
      key: 'yt_channel',
      label: 'YouTube 頻道',
      contentTypes: ['video', 'short'],
      capabilities: { reply: true, like: false, hide: true, delete: true, block: true },
    },
  ],
});

const google = createMockAdapter({
  platform: 'google',
  label: 'Google 商家',
  accountTypes: [
    {
      key: 'google_business',
      label: 'Google 商家檔案',
      contentTypes: ['business_profile'],
      capabilities: { reply: true, like: false, hide: false, delete: false, block: false },
    },
  ],
});

const adapters = new Map<string, PlatformAdapter>();

/** 註冊（或替換）平台 adapter。接真實 API 時，在啟動時呼叫 registerAdapter(realFacebookAdapter) 即可。 */
export function registerAdapter(adapter: PlatformAdapter): void {
  adapters.set(adapter.platform, adapter);
}

[facebook, instagram, youtube, google].forEach(registerAdapter);

export function getAdapter(platform: string): PlatformAdapter | undefined {
  return adapters.get(platform);
}

export function listAdapters(): PlatformAdapter[] {
  return [...adapters.values()];
}

export function getAccountType(platform: string, accountType: string) {
  return getAdapter(platform)?.accountTypes.find((t) => t.key === accountType);
}

/** adapter_key 寫入資料庫，用來追蹤帳號目前由哪個 adapter 負責 */
export function adapterKeyFor(platform: string): string {
  const a = getAdapter(platform);
  if (!a) throw new Error(`未知的平台：${platform}`);
  return `${a.isMock ? 'mock' : 'live'}:${a.platform}`;
}

export function platformMeta(): PlatformMeta[] {
  return listAdapters().map((a) => ({
    key: a.platform,
    label: a.label,
    isMock: a.isMock,
    accountTypes: a.accountTypes.map((t) => ({ ...t })),
  }));
}
