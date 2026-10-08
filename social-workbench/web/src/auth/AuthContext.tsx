import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError, setUnauthorizedHandler } from '../lib/api';
import { can as canRole, type Permission } from '../../../shared/permissions';
import type { BrandSummary, MeResponse, SessionUser } from '../../../shared/types';
import { Loading } from '../components/ui';

interface AuthState {
  user: SessionUser | null;
  /** 可存取的品牌（管理員含已停用品牌） */
  brands: BrandSummary[];
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 重新取得登入者資料（例如品牌或權限變更後） */
  refresh: () => Promise<void>;
  /** 套用 /auth/login 或其他回傳 MeResponse 的 API 結果 */
  applyMe: (me: MeResponse) => void;
  can: (permission: Permission) => boolean;
  /** 被登出時顯示在登入頁的提示 */
  logoutReason: string | null;
}

const AuthContext = createContext<AuthState | null>(null);

/** sessionStorage key：設定後，示範模式不自動登入 */
export const MANUAL_LOGIN_KEY = 'swb.manualLogin';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [brands, setBrands] = useState<BrandSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [logoutReason, setLogoutReason] = useState<string | null>(null);

  const applyMe = useCallback((me: MeResponse) => {
    setUser(me.user);
    setBrands(me.brands);
    setLogoutReason(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyMe(await api.get<MeResponse>('/auth/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setBrands([]);
      } else {
        throw err;
      }
    }
  }, [applyMe]);

  useEffect(() => {
    refresh()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser((prev) => {
        if (prev) setLogoutReason('登入已逾時或帳號狀態變更，請重新登入');
        return null;
      });
      setBrands([]);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      applyMe(await api.post<MeResponse>('/auth/login', { email, password }));
    },
    [applyMe],
  );

  const logout = useCallback(async () => {
    // 主動登出後，登入頁不再自動以示範帳號進入（直到關閉分頁）
    try {
      sessionStorage.setItem(MANUAL_LOGIN_KEY, '1');
    } catch {
      /* 忽略 */
    }
    try {
      await api.post('/auth/logout');
    } finally {
      setUser(null);
      setBrands([]);
      setLogoutReason(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      brands,
      loading,
      login,
      logout,
      refresh,
      applyMe,
      can: (p) => canRole(user?.role, p),
      logoutReason,
    }),
    [user, brands, loading, login, logout, refresh, applyMe, logoutReason],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必須在 AuthProvider 內使用');
  return ctx;
}

/** 需要登入才能看的頁面 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading text="確認登入狀態…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}
