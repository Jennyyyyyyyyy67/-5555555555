// Facebook adapter：已透過 Facebook 登入連結的粉絲專頁（有粉專權杖）走真實 API，其餘（示範帳號）沿用模擬 adapter。
import type { AdapterAccount, IncomingComment, IncomingPost, PlatformAdapter } from './types';
import * as fb from '../integrations/facebook';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function titleOf(p: fb.FbPost): string {
  const first = (p.message ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
  if (first) return [...first].length > 40 ? `${[...first].slice(0, 40).join('')}…` : first;
  return `Facebook 貼文（${p.created_time.slice(0, 10)}）`;
}

const lastComplete = new Map<number, string[]>();
/** 最近一次同步的統計（排查「粉專有留言但 API 沒回傳」用） */
export const lastFacebookStats = new Map<number, { posts: number; countedComments: number; returned: number }>();

export function createFacebookAdapter(mock: PlatformAdapter): PlatformAdapter {
  const live = (a: AdapterAccount) => !!a.accessToken && a.accountType === 'fb_page';
  return {
    platform: mock.platform,
    label: mock.label,
    isMock: mock.isMock,
    accountTypes: mock.accountTypes,

    async testConnection(a) {
      if (!live(a)) return mock.testConnection(a);
      try {
        await fb.listPosts(a.accessToken!, a.externalId, 1);
        return { ok: true, message: `已連線到 Facebook 粉專「${a.name}」` };
      } catch (e) {
        return { ok: false, message: errMsg(e) };
      }
    },

    async fetchPosts(a): Promise<IncomingPost[]> {
      if (!live(a)) return [];
      const posts = await fb.listPosts(a.accessToken!, a.externalId, 25);
      return posts.map((p) => ({
        externalId: p.id,
        contentType: 'post',
        isAd: false,
        title: titleOf(p),
        body: p.message ?? '',
        url: p.permalink_url ?? '',
        publishedAt: new Date(p.created_time).toISOString(),
      }));
    },

    async fetchComments(a, opts) {
      if (!live(a)) return mock.fetchComments(a, opts);
      const token = a.accessToken!;
      const posts = await fb.listPosts(token, a.externalId, 25);
      const lists = await Promise.all(posts.map((p) => fb.listComments(token, p.id).then((r) => ({ p, ...r }))));
      const counted = (p: fb.FbPost) => p.comments?.summary?.total_count ?? 0;
      lastFacebookStats.set(a.id, {
        posts: posts.length,
        countedComments: posts.reduce((n, p) => n + counted(p), 0),
        returned: lists.reduce((n, l) => n + l.data.length, 0),
      });
      // 防呆：回傳的留言明顯少於貼文顯示的數量（權限不足被隱藏），就不用來判斷刪除
      lastComplete.set(a.id, lists.filter((l) => l.complete && l.data.length >= counted(l.p) * 0.8).map((l) => l.p.id));
      const out: IncomingComment[] = [];
      for (const { p, data } of lists) {
        // 粉專自己的留言（小編直接在 Facebook 上的回覆）：from.id 等於粉專 id
        const isOwn = (c: fb.FbComment) => c.from?.id === a.externalId;
        for (const c of data) {
          const ownReplies = data.filter((r) => r.parent?.id === c.id && isOwn(r)).sort((x, y) => x.created_time.localeCompare(y.created_time));
          out.push({
            externalId: c.id,
            postExternalId: p.id,
            parentExternalId: c.parent?.id ?? null,
            // 沒有「讀取使用者內容」進階權限時，Facebook 不會提供留言者名稱
            authorName: c.from?.name ?? 'Facebook 使用者',
            authorExternalId: c.from?.id ?? '',
            body: c.message ?? '',
            likeCount: c.like_count ?? 0,
            occurredAt: new Date(c.created_time).toISOString(),
            isOwn: isOwn(c),
            hasOwnReply: ownReplies.length > 0,
            ownReplyAt: ownReplies[0] ? new Date(ownReplies[0].created_time).toISOString() : null,
          });
        }
      }
      return out.sort((x, y) => x.occurredAt.localeCompare(y.occurredAt));
    },

    completePostIds(a) {
      return live(a) ? (lastComplete.get(a.id) ?? []) : [];
    },

    async replyToComment(a, target, body) {
      if (!live(a)) return mock.replyToComment(a, target, body);
      try {
        return { ok: true, externalReplyId: await fb.replyToComment(a.accessToken!, target.externalId, body) };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    async performAction(a, target, action) {
      if (!live(a)) return mock.performAction(a, target, action);
      try {
        if (action === 'hide' || action === 'unhide') await fb.setHidden(a.accessToken!, target.externalId, action === 'hide');
        else if (action === 'like' || action === 'unlike') await fb.setLiked(a.accessToken!, target.externalId, action === 'like');
        else if (action === 'delete') await fb.deleteComment(a.accessToken!, target.externalId);
        else return { ok: false, error: '請直接在 Facebook 粉專的設定中封鎖使用者（API 無法從留言封鎖）' };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },
  };
}
