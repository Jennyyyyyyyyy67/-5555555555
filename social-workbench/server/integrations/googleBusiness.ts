// Google 商家檔案（Business Profile）API：商家地點與顧客評論、回覆評論。
// 官方文件：https://developers.google.com/my-business
// 注意：Google 需要先審核通過 API 使用申請（免費），未通過前呼叫會回傳配額為 0 的錯誤。
import { bearer, googleCall } from './google';

const SERVICE = 'Google 商家檔案';

export interface GbpLocation {
  /** accounts/123/locations/456 */
  name: string;
  title: string;
  address: string;
}

/** 這個 Google 帳號可以管理的所有商家地點 */
export async function listLocations(token: string): Promise<GbpLocation[]> {
  const accounts = await googleCall<{ accounts?: Array<{ name: string }> }>('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { service: SERVICE, headers: bearer(token) });
  const out: GbpLocation[] = [];
  for (const a of accounts.accounts ?? []) {
    let pageToken = '';
    do {
      const p = new URLSearchParams({ readMask: 'name,title,storefrontAddress', pageSize: '100' });
      if (pageToken) p.set('pageToken', pageToken);
      const r = await googleCall<{
        locations?: Array<{ name: string; title: string; storefrontAddress?: { addressLines?: string[]; locality?: string; administrativeArea?: string } }>;
        nextPageToken?: string;
      }>(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?${p}`, { service: SERVICE, headers: bearer(token) });
      for (const l of r.locations ?? []) {
        const addr = l.storefrontAddress;
        out.push({
          // locations/456 → accounts/123/locations/456（評論 API 需要完整路徑）
          name: `${a.name}/${l.name}`,
          title: l.title,
          address: addr ? [addr.administrativeArea, addr.locality, ...(addr.addressLines ?? [])].filter(Boolean).join('') : '',
        });
      }
      pageToken = r.nextPageToken ?? '';
    } while (pageToken);
  }
  return out;
}

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export interface GbpReview {
  /** accounts/../locations/../reviews/.. */
  name: string;
  reviewId: string;
  reviewerName: string;
  rating: number | null;
  comment: string;
  createTime: string;
  updateTime: string;
  reply: { comment: string; updateTime: string } | null;
}

/** 最新的評論（最多 maxPages × 50 則）；complete 表示已取回所有評論 */
export async function listReviews(token: string, location: string, maxPages = 4): Promise<{ reviews: GbpReview[]; complete: boolean; total: number }> {
  const reviews: GbpReview[] = [];
  let pageToken = '';
  let total = 0;
  let page = 0;
  do {
    const p = new URLSearchParams({ pageSize: '50', orderBy: 'updateTime desc' });
    if (pageToken) p.set('pageToken', pageToken);
    const r = await googleCall<{
      reviews?: Array<{
        name: string;
        reviewId: string;
        reviewer?: { displayName?: string; isAnonymous?: boolean };
        starRating?: string;
        comment?: string;
        createTime: string;
        updateTime: string;
        reviewReply?: { comment: string; updateTime: string };
      }>;
      totalReviewCount?: number;
      nextPageToken?: string;
    }>(`https://mybusiness.googleapis.com/v4/${location}/reviews?${p}`, { service: SERVICE, headers: bearer(token) });
    total = r.totalReviewCount ?? total;
    for (const x of r.reviews ?? []) {
      reviews.push({
        name: x.name,
        reviewId: x.reviewId,
        reviewerName: x.reviewer?.isAnonymous ? 'Google 使用者' : (x.reviewer?.displayName ?? 'Google 使用者'),
        rating: x.starRating ? (STARS[x.starRating] ?? null) : null,
        comment: x.comment ?? '',
        createTime: x.createTime,
        updateTime: x.updateTime,
        reply: x.reviewReply ?? null,
      });
    }
    pageToken = r.nextPageToken ?? '';
    page++;
  } while (pageToken && page < maxPages);
  return { reviews, complete: !pageToken, total };
}

/** 回覆評論（已回覆過會改成新的內容） */
export async function replyToReview(token: string, reviewName: string, comment: string): Promise<void> {
  await googleCall(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, {
    service: SERVICE,
    method: 'PUT',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
}
