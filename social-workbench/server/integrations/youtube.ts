// YouTube Data API v3：頻道資訊、最新影片、影片留言、回覆與審核留言。
// 官方文件：https://developers.google.com/youtube/v3/docs
// 每天免費配額 10,000 點：讀取約 1 點／次，回覆、審核約 50 點／次，因此 YouTube 每 5 分鐘才自動同步一次。
import { bearer, googleCall } from './google';

const API = 'https://www.googleapis.com/youtube/v3';
const SERVICE = 'YouTube';
const get = <T>(path: string, params: Record<string, string>, token: string) => googleCall<T>(`${API}/${path}?${new URLSearchParams(params)}`, { service: SERVICE, headers: bearer(token) });

export interface YtChannel {
  id: string;
  title: string;
  handle: string;
  uploadsPlaylistId: string;
}

/** 授權帳號的頻道（一個 Google 帳號可能管理多個頻道，登入時選的那一個） */
export async function getMyChannel(token: string): Promise<YtChannel> {
  const r = await get<{ items?: Array<{ id: string; snippet: { title: string; customUrl?: string }; contentDetails: { relatedPlaylists: { uploads: string } } }> }>(
    'channels',
    { part: 'snippet,contentDetails', mine: 'true' },
    token,
  );
  const c = r.items?.[0];
  if (!c) throw new Error('這個 Google 帳號沒有 YouTube 頻道；如果頻道屬於品牌帳戶，登入時請選擇該頻道');
  return { id: c.id, title: c.snippet.title, handle: c.snippet.customUrl ?? '', uploadsPlaylistId: c.contentDetails.relatedPlaylists.uploads };
}

export interface YtVideo {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  /** 3 分鐘以內的直式短片視為 Shorts */
  isShort: boolean;
}

function seconds(iso: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return Infinity;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

/** 頻道最新上傳的影片 */
export async function listVideos(token: string, uploadsPlaylistId: string, max = 25): Promise<YtVideo[]> {
  const items = await get<{ items?: Array<{ snippet: { title: string; description: string }; contentDetails: { videoId: string; videoPublishedAt?: string } }> }>(
    'playlistItems',
    { part: 'snippet,contentDetails', playlistId: uploadsPlaylistId, maxResults: String(max) },
    token,
  );
  const list = (items.items ?? []).filter((i) => i.contentDetails.videoPublishedAt);
  if (list.length === 0) return [];
  const details = await get<{ items?: Array<{ id: string; contentDetails: { duration: string } }> }>(
    'videos',
    { part: 'contentDetails', id: list.map((i) => i.contentDetails.videoId).join(',') },
    token,
  );
  const dur = new Map((details.items ?? []).map((d) => [d.id, seconds(d.contentDetails.duration)]));
  return list.map((i) => ({
    id: i.contentDetails.videoId,
    title: i.snippet.title,
    description: i.snippet.description,
    publishedAt: i.contentDetails.videoPublishedAt!,
    isShort: (dur.get(i.contentDetails.videoId) ?? Infinity) <= 180,
  }));
}

export interface YtComment {
  id: string;
  videoId: string;
  parentId: string | null;
  authorName: string;
  authorChannelId: string;
  text: string;
  likeCount: number;
  publishedAt: string;
}

interface RawComment {
  id: string;
  snippet: {
    videoId?: string;
    parentId?: string;
    authorDisplayName: string;
    authorChannelId?: { value: string };
    textOriginal?: string;
    textDisplay?: string;
    likeCount?: number;
    publishedAt: string;
  };
}

const toComment = (c: RawComment, videoId: string): YtComment => ({
  id: c.id,
  videoId: c.snippet.videoId ?? videoId,
  parentId: c.snippet.parentId ?? null,
  authorName: c.snippet.authorDisplayName,
  authorChannelId: c.snippet.authorChannelId?.value ?? '',
  text: c.snippet.textOriginal ?? c.snippet.textDisplay ?? '',
  likeCount: c.snippet.likeCount ?? 0,
  publishedAt: c.snippet.publishedAt,
});

/**
 * 頻道所有影片最新的留言串（一次 1 點配額），含每串最多 5 則回覆；回覆更多的串再另外補抓。
 */
export async function listChannelComments(token: string, channelId: string, maxThreads = 100): Promise<YtComment[]> {
  const r = await get<{
    items?: Array<{ id: string; snippet: { videoId?: string; totalReplyCount: number; topLevelComment: RawComment }; replies?: { comments: RawComment[] } }>;
  }>('commentThreads', { part: 'snippet,replies', allThreadsRelatedToChannelId: channelId, maxResults: String(maxThreads), order: 'time', textFormat: 'plainText' }, token);
  const out: YtComment[] = [];
  for (const t of r.items ?? []) {
    const videoId = t.snippet.videoId ?? t.snippet.topLevelComment.snippet.videoId ?? '';
    if (!videoId) continue; // 頻道本身的討論，不屬於任何影片
    out.push(toComment(t.snippet.topLevelComment, videoId));
    let replies = t.replies?.comments ?? [];
    if (t.snippet.totalReplyCount > replies.length) {
      const more = await get<{ items?: RawComment[] }>('comments', { part: 'snippet', parentId: t.id, maxResults: '100', textFormat: 'plainText' }, token);
      replies = more.items ?? replies;
    }
    out.push(...replies.map((c) => toComment(c, videoId)));
  }
  return out;
}

/** 以頻道身分回覆留言（回覆只能掛在第一層留言底下） */
export async function replyToComment(token: string, parentId: string, text: string): Promise<string> {
  const r = await googleCall<{ id: string }>(`${API}/comments?part=snippet`, {
    service: SERVICE,
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippet: { parentId, textOriginal: text } }),
  });
  return r.id;
}

export type YtModeration = 'heldForReview' | 'published' | 'rejected';

/** 審核留言：保留待審（隱藏）、公開、拒絕（移除），拒絕時可同時封鎖作者 */
export async function setModerationStatus(token: string, commentId: string, status: YtModeration, banAuthor = false): Promise<void> {
  const p = new URLSearchParams({ id: commentId, moderationStatus: status });
  if (banAuthor) p.set('banAuthor', 'true');
  await googleCall(`${API}/comments/setModerationStatus?${p}`, { service: SERVICE, method: 'POST', headers: bearer(token) });
}
