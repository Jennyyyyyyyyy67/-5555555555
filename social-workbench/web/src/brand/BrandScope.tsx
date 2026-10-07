import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { BrandSummary } from '../../../shared/types';

const STORAGE_KEY = 'swb.brandScope';

interface BrandScopeState {
  /** 'all' 代表「全部負責品牌」，否則為品牌 id */
  selected: number | 'all';
  setSelected: (v: number | 'all') => void;
  /** 傳給 API 的 ?brand= 參數值 */
  brandParam: string;
  /** 目前選取的品牌（選「全部」時為 undefined） */
  currentBrand: BrandSummary | undefined;
  /** 啟用中且可存取的品牌，供選單使用 */
  activeBrands: BrandSummary[];
}

const BrandScopeContext = createContext<BrandScopeState | null>(null);

function readStored(): number | 'all' {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v || v === 'all') return 'all';
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : 'all';
  } catch {
    return 'all';
  }
}

export function BrandScopeProvider({ children }: { children: ReactNode }) {
  const { brands, user } = useAuth();
  const [selected, setSelectedState] = useState<number | 'all'>(readStored);
  const activeBrands = useMemo(() => brands.filter((b) => b.isActive), [brands]);

  // 品牌權限變動（或換人登入）時，若選取的品牌已無權限則回到「全部」
  useEffect(() => {
    if (selected !== 'all' && user && !activeBrands.some((b) => b.id === selected)) setSelectedState('all');
  }, [activeBrands, selected, user]);

  const setSelected = useCallback((v: number | 'all') => {
    setSelectedState(v);
    try {
      localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
      /* 無痕模式等情況忽略 */
    }
  }, []);

  const value = useMemo<BrandScopeState>(
    () => ({
      selected,
      setSelected,
      brandParam: String(selected),
      currentBrand: selected === 'all' ? undefined : activeBrands.find((b) => b.id === selected),
      activeBrands,
    }),
    [selected, setSelected, activeBrands],
  );
  return <BrandScopeContext.Provider value={value}>{children}</BrandScopeContext.Provider>;
}

/** 頂部品牌切換器的狀態。頁面查詢資料時把 brandParam 當作 ?brand= 傳給 API。 */
export function useBrandScope(): BrandScopeState {
  const ctx = useContext(BrandScopeContext);
  if (!ctx) throw new Error('useBrandScope 必須在 BrandScopeProvider 內使用');
  return ctx;
}
