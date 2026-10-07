import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { api } from './api';
import { useQuery } from './useQuery';
import type { MetaResponse, PlatformMeta } from '../../../shared/types';
import { ACCOUNT_TYPE_LABELS, PLATFORM_LABELS } from '../../../shared/constants';

interface MetaState {
  meta: MetaResponse | undefined;
  loading: boolean;
  reload: () => Promise<void>;
  platformLabel: (key: string) => string;
  accountTypeLabel: (key: string) => string;
  platform: (key: string) => PlatformMeta | undefined;
}

const MetaContext = createContext<MetaState | null>(null);

/** 系統中繼資料（平台、帳號類型、可用動作、留言類型）。登入後載入一次。 */
export function MetaProvider({ children }: { children: ReactNode }) {
  const { data, loading, reload } = useQuery(() => api.get<MetaResponse>('/meta'), []);
  const value = useMemo<MetaState>(() => {
    const platforms = data?.platforms ?? [];
    return {
      meta: data,
      loading,
      reload,
      platform: (key) => platforms.find((p) => p.key === key),
      platformLabel: (key) => platforms.find((p) => p.key === key)?.label ?? PLATFORM_LABELS[key] ?? key,
      accountTypeLabel: (key) =>
        platforms.flatMap((p) => p.accountTypes).find((t) => t.key === key)?.label ?? ACCOUNT_TYPE_LABELS[key] ?? key,
    };
  }, [data, loading, reload]);
  return <MetaContext.Provider value={value}>{children}</MetaContext.Provider>;
}

export function useMeta(): MetaState {
  const ctx = useContext(MetaContext);
  if (!ctx) throw new Error('useMeta 必須在 MetaProvider 內使用');
  return ctx;
}
