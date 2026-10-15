// Instagram adapter：已透過 Instagram 登入連結（有存取權杖）的帳號走真實 API，其餘（示範帳號）沿用模擬 adapter。
import type { AdapterAccount, IncomingComment, IncomingPost, PlatformAdapter } from './types';
import type { ContentType } from '../../shared/constants';
import * as ig from '../integrations/instagram';

function contentType(m: ig.IgMedia): ContentType {
  if (m.media_product_type === 'REELS') return 'reel';
  if (m.media_product_type === 'AD') return 'ad';
  return 'post';
}

function titleOf(m: ig.IgMedia): string {
  const first = (m.caption ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
  if (first) return [...first].length > 40 ? `${[...first].slice(0, 40).join('')}…` : first;
  return `Instagram ${m.media_product_type === 'REELS' ? 'Reels' : '貼文'}（${m.timestamp.slice(0, 10)}）`;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function toIncoming(c: ig.IgComment, mediaId: string, parentId: string | null): IncomingComment {
  const username = c.username ?? c.from?.username ?? '';
  return {
    externalId: c.id,
    postExternalId: mediaId,
    parentExternalId: parentId,
    authorName: username ? `@${username}` : 'Instagram 使用者',
    authorExternalId: c.from?.id ?? username,
    body: c.text ?? '',
    likeCount: c.like_count ?? 0,
    occurredAt: new Date(c.timestamp).toISOString(),
  };
}

/** 最近一次同步的統計（排查「IG 有留言但 API 沒回傳」用） */
const lastComplete = new Map<number, string[]>();
export const lastInstagramStats = new Map<number, { media: number; countedComments: number; returnedTopLevel: number }>();

export function createInstagramAdapter(mock: PlatformAdapter): PlatformAdapter {
  const live = (a: AdapterAccount) => !!a.accessToken;
  return {
    platform: mock.platform,
    label: mock.label,
    isMock: mock.isMock,
    accountTypes: mock.accountTypes,

    async testConnection(a) {
      if (!live(a)) return mock.testConnection(a);
      try {
        const p = await ig.getProfile(a.accessToken!);
        return { ok: true, message: `已連線到 Instagram 帳號 @${p.username}` };
      } catch (e) {
        return { ok: false, message: errMsg(e) };
      }
    },

    async fetchPosts(a): Promise<IncomingPost[]> {
      if (!live(a)) return [];
      const media = await ig.listMedia(a.accessToken!, 25);
      return media.map((m) => ({
        externalId: m.id,
        contentType: contentType(m),
        isAd: m.media_product_type === 'AD',
        title: titleOf(m),
        body: m.caption ?? '',
        url: m.permalink ?? '',
        publishedAt: new Date(m.timestamp).toISOString(),
      }));
    },

    async fetchComments(a, opts) {
      if (!live(a)) return mock.fetchComments(a, opts);
      const token = a.accessToken!;
      const [media, me] = await Promise.all([ig.listMedia(token, 25), ig.getOwnIdentity(token).catch(() => null)]);
      const ownIds = new Set([a.externalId, ...(me?.ids ?? [])]);
      const ownName = (me?.username ?? '').toLowerCase();
      const lists = await Promise.all(media.map((m) => ig.listCommentsPaged(token, m.id).then((r) => ({ m, cs: r.data, complete: r.complete }))));
      // 防呆：平台回傳的留言數明顯少於貼文顯示的留言數（例如權限不足被隱藏），就不用來判斷刪除
      const returned = (l: { cs: ig.IgComment[] }) => l.cs.reduce((n, c) => n + 1 + (c.replies?.data?.length ?? 0), 0);
      lastComplete.set(a.id, lists.filter((l) => l.complete && returned(l) >= (l.m.comments_count ?? 0) * 0.8).map((l) => l.m.id));
      lastInstagramStats.set(a.id, {
        media: media.length,
        countedComments: media.reduce((n, m) => n + (m.comments_count ?? 0), 0),
        returnedTopLevel: lists.reduce((n, l) => n + l.cs.length, 0),
      });
      const authorOf = (c: ig.IgComment) => ({ id: c.from?.id ?? '', name: (c.username ?? c.from?.username ?? '').toLowerCase() });
      const isOwn = (c: ig.IgComment) => {
        const x = authorOf(c);
        return (!!x.id && ownIds.has(x.id)) || (!!ownName && x.name === ownName);
      };
      const out: IncomingComment[] = [];
      for (const { m, cs } of lists) {
        for (const c of cs) {
          let replies = c.replies?.data ?? [];
          // 巢狀查詢常常不回傳回覆的作者，這時另外查一次這則留言的回覆
          if (replies.some((r) => !authorOf(r).id && !authorOf(r).name)) {
            const full = await ig.listReplies(token, c.id).catch(() => [] as ig.IgComment[]);
            replies = replies.map((r) => full.find((f) => f.id === r.id) ?? r);
            for (const f of full) if (!replies.some((r) => r.id === f.id)) replies.push(f);
          }
          // 還是查不到作者的回覆：Instagram 對其他使用者一定會回傳帳號名稱，查不到的視為本帳號自己的回覆
          const own = (r: ig.IgComment) => isOwn(r) || (!authorOf(r).id && !authorOf(r).name);
          const ownReplies = replies.filter(own).sort((x, y) => x.timestamp.localeCompare(y.timestamp));
          out.push({
            ...toIncoming(c, m.id, null),
            isOwn: isOwn(c),
            hasOwnReply: ownReplies.length > 0,
            ownReplyAt: ownReplies[0] ? new Date(ownReplies[0].timestamp).toISOString() : null,
          });
          for (const r of replies) out.push({ ...toIncoming(r, m.id, r.parent_id ?? c.id), isOwn: own(r) });
        }
      }
      // 舊的在前，被回覆的留言會先寫入
      return out.sort((x, y) => x.occurredAt.localeCompare(y.occurredAt));
    },

    completePostIds(a) {
      return live(a) ? (lastComplete.get(a.id) ?? []) : [];
    },

    async replyToComment(a, target, body) {
      if (!live(a)) return mock.replyToComment(a, target, body);
      try {
        return { ok: true, externalReplyId: await ig.replyToComment(a.accessToken!, target.externalId, body) };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    async performAction(a, target, action) {
      if (!live(a)) return mock.performAction(a, target, action);
      try {
        if (action === 'hide' || action === 'unhide') await ig.setHidden(a.accessToken!, target.externalId, action === 'hide');
        else if (action === 'delete') await ig.deleteComment(a.accessToken!, target.externalId);
        else return { ok: false, error: 'Instagram API 不支援這個動作' };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },
  };
}
