// Google 商家 adapter：已透過 Google 登入連結的商家地點走真實 API（評論與回覆），其餘（示範帳號）沿用模擬 adapter。
// 每個商家地點是一個社群帳號，地點本身當作一則「內容」，顧客評論當作留言。
import type { AdapterAccount, IncomingComment, IncomingPost, PlatformAdapter } from './types';
import { accessTokenFor } from '../integrations/google';
import * as gbp from '../integrations/googleBusiness';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const lastComplete = new Map<number, boolean>();

export function createGoogleBusinessAdapter(mock: PlatformAdapter): PlatformAdapter {
  const live = (a: AdapterAccount) => !!a.accessToken && a.accountType === 'google_business';
  const token = (a: AdapterAccount) => accessTokenFor(a.accessToken!);

  return {
    platform: mock.platform,
    label: mock.label,
    isMock: mock.isMock,
    accountTypes: mock.accountTypes,

    async testConnection(a) {
      if (!live(a)) return mock.testConnection(a);
      try {
        const r = await gbp.listReviews(await token(a), a.externalId, 1);
        return { ok: true, message: `已連線到 Google 商家「${a.name}」（共 ${r.total} 則評論）` };
      } catch (e) {
        return { ok: false, message: errMsg(e) };
      }
    },

    async fetchPosts(a): Promise<IncomingPost[]> {
      if (!live(a)) return [];
      return [
        {
          externalId: a.externalId,
          contentType: 'business_profile',
          isAd: false,
          title: `${a.name}（Google 商家評論）`,
          body: '',
          url: 'https://business.google.com/reviews',
          publishedAt: new Date(0).toISOString(),
        },
      ];
    },

    async fetchComments(a, opts) {
      if (!live(a)) return mock.fetchComments(a, opts);
      const r = await gbp.listReviews(await token(a), a.externalId);
      lastComplete.set(a.id, r.complete);
      return r.reviews
        .map(
          (x): IncomingComment => ({
            externalId: x.name,
            postExternalId: a.externalId,
            parentExternalId: null,
            authorName: x.reviewerName,
            authorExternalId: '',
            // 只有星等、沒有文字的評論
            body: x.comment || `（只給了 ${x.rating ?? '?'} 顆星，沒有留下文字）`,
            rating: x.rating,
            occurredAt: new Date(x.createTime).toISOString(),
            hasOwnReply: !!x.reply,
            ownReplyAt: x.reply ? new Date(x.reply.updateTime).toISOString() : null,
          }),
        )
        .sort((x, y) => x.occurredAt.localeCompare(y.occurredAt));
    },

    completePostIds(a) {
      return live(a) && lastComplete.get(a.id) ? [a.externalId] : [];
    },

    async replyToComment(a, target, body) {
      if (!live(a)) return mock.replyToComment(a, target, body);
      try {
        await gbp.replyToReview(await token(a), target.externalId, body);
        // 一則評論只會有一個商家回覆，再次回覆會取代原本的內容
        return { ok: true, externalReplyId: `${target.externalId}/reply` };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    async performAction(a, target, action) {
      if (!live(a)) return mock.performAction(a, target, action);
      return { ok: false, error: 'Google 商家評論只能回覆，無法隱藏、刪除或按讚；不當評論請到 Google 商家檔案檢舉' };
    },
  };
}
