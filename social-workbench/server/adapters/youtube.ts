// YouTube adapter：已透過 Google 登入連結的頻道走真實 API，其餘（示範帳號）沿用模擬 adapter。
// 帳號的權杖欄位存的是 Google 更新權杖，每次呼叫前換成短效的存取權杖。
import type { AdapterAccount, IncomingComment, IncomingPost, PlatformAdapter } from './types';
import { accessTokenFor } from '../integrations/google';
import * as yt from '../integrations/youtube';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 回覆的 id 是「第一層留言 id.回覆 id」；YouTube 只能回覆第一層留言 */
const topLevelId = (commentId: string) => commentId.split('.')[0];

export function createYoutubeAdapter(mock: PlatformAdapter): PlatformAdapter {
  const live = (a: AdapterAccount) => !!a.accessToken && a.accountType === 'yt_channel';
  const token = (a: AdapterAccount) => accessTokenFor(a.accessToken!);
  const uploads = new Map<number, string>();

  return {
    platform: mock.platform,
    label: mock.label,
    isMock: mock.isMock,
    accountTypes: mock.accountTypes,

    async testConnection(a) {
      if (!live(a)) return mock.testConnection(a);
      try {
        const c = await yt.getMyChannel(await token(a));
        return { ok: true, message: `已連線到 YouTube 頻道「${c.title}」` };
      } catch (e) {
        return { ok: false, message: errMsg(e) };
      }
    },

    async fetchPosts(a): Promise<IncomingPost[]> {
      if (!live(a)) return [];
      const t = await token(a);
      let playlist = uploads.get(a.id);
      if (!playlist) {
        playlist = (await yt.getMyChannel(t)).uploadsPlaylistId;
        uploads.set(a.id, playlist);
      }
      const videos = await yt.listVideos(t, playlist, 25);
      return videos.map((v) => ({
        externalId: v.id,
        contentType: v.isShort ? 'short' : 'video',
        isAd: false,
        title: v.title,
        body: v.description.slice(0, 2000),
        url: v.isShort ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`,
        publishedAt: new Date(v.publishedAt).toISOString(),
      }));
    },

    async fetchComments(a, opts) {
      if (!live(a)) return mock.fetchComments(a, opts);
      const list = await yt.listChannelComments(await token(a), a.externalId, 100);
      const isOwn = (c: yt.YtComment) => c.authorChannelId === a.externalId;
      const out: IncomingComment[] = list.map((c) => {
        const own = list.filter((r) => r.parentId === c.id && isOwn(r)).sort((x, y) => x.publishedAt.localeCompare(y.publishedAt));
        return {
          externalId: c.id,
          postExternalId: c.videoId,
          parentExternalId: c.parentId,
          authorName: c.authorName || 'YouTube 使用者',
          authorExternalId: c.authorChannelId,
          body: c.text,
          likeCount: c.likeCount,
          occurredAt: new Date(c.publishedAt).toISOString(),
          isOwn: isOwn(c),
          hasOwnReply: own.length > 0,
          ownReplyAt: own[0] ? new Date(own[0].publishedAt).toISOString() : null,
        };
      });
      return out.sort((x, y) => x.occurredAt.localeCompare(y.occurredAt));
    },

    // 一次只取最新的留言串，無法確認某部影片的留言是否完整，所以不用來判斷刪除
    completePostIds() {
      return [];
    },

    async replyToComment(a, target, body) {
      if (!live(a)) return mock.replyToComment(a, target, body);
      try {
        return { ok: true, externalReplyId: await yt.replyToComment(await token(a), topLevelId(target.externalId), body) };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    async performAction(a, target, action) {
      if (!live(a)) return mock.performAction(a, target, action);
      try {
        const t = await token(a);
        if (action === 'hide') await yt.setModerationStatus(t, target.externalId, 'heldForReview');
        else if (action === 'unhide') await yt.setModerationStatus(t, target.externalId, 'published');
        else if (action === 'delete') await yt.setModerationStatus(t, target.externalId, 'rejected');
        else if (action === 'block') await yt.setModerationStatus(t, target.externalId, 'rejected', true);
        else return { ok: false, error: 'YouTube API 不支援對留言按讚' };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },
  };
}
