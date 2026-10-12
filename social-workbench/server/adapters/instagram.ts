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
      const media = await ig.listMedia(a.accessToken!, 10);
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
      const media = await ig.listMedia(a.accessToken!, 10);
      const lists = await Promise.all(media.map((m) => ig.listComments(a.accessToken!, m.id).then((cs) => ({ m, cs }))));
      const out: IncomingComment[] = [];
      for (const { m, cs } of lists) {
        for (const c of cs) {
          out.push(toIncoming(c, m.id, null));
          for (const r of c.replies?.data ?? []) out.push(toIncoming(r, m.id, r.parent_id ?? c.id));
        }
      }
      // 舊的在前，被回覆的留言會先寫入
      return out.sort((x, y) => x.occurredAt.localeCompare(y.occurredAt));
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
