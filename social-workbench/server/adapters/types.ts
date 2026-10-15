// 平台串接介面：每個社群平台實作一個 PlatformAdapter。
// 第一版全部使用模擬 adapter；日後接真實 API 時，只要新增／替換 adapter，不需修改其他程式。
import type { ContentType, InteractionAction } from '../../shared/constants';
import type { AccountTypeMeta, PlatformCapabilities } from '../../shared/types';

export type { PlatformCapabilities };

export interface AccountTypeDef extends AccountTypeMeta {}

/** adapter 操作時需要的帳號資訊 */
export interface AdapterAccount {
  id: number;
  brandId: number;
  platform: string;
  accountType: string;
  externalId: string;
  name: string;
  /** 真實平台的存取權杖（只有已透過 OAuth 連結的帳號才有；模擬帳號為空） */
  accessToken?: string | null;
}

/** 平台上的一則留言（尚未寫入資料庫的原始格式） */
export interface IncomingComment {
  externalId: string;
  postExternalId: string;
  /** 回覆其他留言時，被回覆留言的 externalId */
  parentExternalId?: string | null;
  authorName: string;
  authorExternalId: string;
  body: string;
  /** Google 商家評論星等 1～5 */
  rating?: number | null;
  likeCount?: number;
  occurredAt: string;
  /** 平台上這則留言底下已經有本帳號的回覆（避免重複自動回覆） */
  hasOwnReply?: boolean;
  /** 本帳號最早一則回覆的時間（直接在平台 App 上回覆的也算首次回覆） */
  ownReplyAt?: string | null;
  /** 這則是本帳號自己發的（例如小編在 App 上的回覆），不是要處理的留言 */
  isOwn?: boolean;
}

/** 平台上的貼文／廣告／影片（尚未寫入資料庫的原始格式） */
export interface IncomingPost {
  externalId: string;
  contentType: ContentType;
  isAd: boolean;
  adCampaign?: string | null;
  title: string;
  body: string;
  url: string;
  publishedAt: string;
}

export interface CommentTarget {
  externalId: string;
  postExternalId: string;
}

export type AdapterResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface PlatformAdapter {
  /** 平台代碼，例如 facebook */
  readonly platform: string;
  readonly label: string;
  /** true 表示模擬 adapter（尚未串接真實 API） */
  readonly isMock: boolean;
  readonly accountTypes: AccountTypeDef[];

  /** 測試帳號連線 */
  testConnection(account: AdapterAccount): Promise<{ ok: boolean; message: string }>;
  /** 取得帳號最近的貼文（真實平台用；模擬 adapter 不需實作） */
  fetchPosts?(account: AdapterAccount): Promise<IncomingPost[]>;
  /** 取得某時間點之後的新留言 */
  fetchComments(account: AdapterAccount, opts: { since?: string | null }): Promise<IncomingComment[]>;
  /**
   * 上一次 fetchComments 中「完整取回所有留言」的貼文 externalId。
   * 這些貼文底下沒出現的留言，代表已在平台上被刪除（只有真實平台實作）。
   */
  completePostIds?(account: AdapterAccount): string[];
  /** 在平台上回覆留言 */
  replyToComment(account: AdapterAccount, target: CommentTarget, body: string): Promise<AdapterResult<{ externalReplyId: string }>>;
  /** 執行互動動作（按讚、隱藏、刪除、封鎖…）；平台不支援的動作會回傳 ok:false */
  performAction(account: AdapterAccount, target: CommentTarget, action: InteractionAction): Promise<AdapterResult>;
}

/** 動作對應到需要的平台能力 */
export function capabilityForAction(action: InteractionAction): keyof PlatformCapabilities {
  switch (action) {
    case 'like':
    case 'unlike':
      return 'like';
    case 'hide':
    case 'unhide':
      return 'hide';
    case 'delete':
      return 'delete';
    case 'block':
      return 'block';
  }
}
