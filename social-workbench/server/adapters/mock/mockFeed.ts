import type { IncomingComment } from '../types';

/**
 * 模擬平台的「新留言佇列」。模擬器（注入新留言、模擬爆量、模擬對方回覆）把留言放進來，
 * 模擬 adapter 的 fetchComments 再把它取出，走與真實平台相同的收件流程。
 */
class MockFeed {
  private queues = new Map<string, IncomingComment[]>();

  private key(platform: string, accountExternalId: string) {
    return `${platform}:${accountExternalId}`;
  }

  push(platform: string, accountExternalId: string, ...comments: IncomingComment[]): void {
    const k = this.key(platform, accountExternalId);
    this.queues.set(k, [...(this.queues.get(k) ?? []), ...comments]);
  }

  drain(platform: string, accountExternalId: string): IncomingComment[] {
    const k = this.key(platform, accountExternalId);
    const items = this.queues.get(k) ?? [];
    this.queues.delete(k);
    return items;
  }

  clear(): void {
    this.queues.clear();
  }
}

export const mockFeed = new MockFeed();
