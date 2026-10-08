import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { MANUAL_LOGIN_KEY, useAuth } from '../auth/AuthContext';
import { api, errorMessage } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { Alert, Avatar, Badge, Button, Field, TextInput } from '../components/ui';
import { ROLE_LABELS, type Role } from '../../../shared/constants';
import type { DemoAccountsResponse } from '../../../shared/types';

const ROLE_TONE: Record<Role, 'purple' | 'blue' | 'gray'> = { admin: 'purple', supervisor: 'blue', operator: 'gray' };

export default function LoginPage() {
  const { user, login, logoutReason, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const demo = useQuery(() => api.get<DemoAccountsResponse>('/auth/demo-accounts'), []);

  // 測試階段（示範模式）：打開網站就自動以示範管理員進入，不必登入。
  // 主動登出後不再自動進入，方便測試登入頁本身。
  const autoTried = useRef(false);
  useEffect(() => {
    if (loading || user || autoTried.current || !demo.data?.enabled) return;
    let manual = false;
    try {
      manual = sessionStorage.getItem(MANUAL_LOGIN_KEY) === '1';
    } catch {
      /* 忽略 */
    }
    const admin = demo.data.accounts.find((a) => a.role === 'admin');
    if (manual || !admin) return;
    autoTried.current = true;
    void doLogin(admin.email, admin.password, admin.email);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user, demo.data]);

  if (!loading && user) return <Navigate to={from && from !== '/login' ? from : '/inbox'} replace />;

  const doLogin = async (e: string, p: string, key: string) => {
    setBusy(key);
    setError(null);
    try {
      await login(e, p);
      navigate(from && from !== '/login' ? from : '/inbox', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('請輸入 Email 與密碼');
      return;
    }
    void doLogin(email.trim(), password, 'form');
  };

  const demoAccounts = demo.data?.enabled ? demo.data.accounts : [];

  return (
    <div className="login-page">
      <div className="login-wrap">
        <section className="card login-card">
          <div className="login-title">
            <span className="avatar" style={{ background: 'linear-gradient(135deg,#3355d6,#7b4fe0)', borderRadius: 10 }} aria-hidden>
              社
            </span>
            <div>
              <h1>社群經營工作台</h1>
              <p className="muted small">不漏留言、快速回覆、品牌一致</p>
            </div>
          </div>
          <form onSubmit={onSubmit} noValidate>
            <div className="stack">
              {logoutReason && <Alert tone="warning">{logoutReason}</Alert>}
              {error && <Alert tone="danger">{error}</Alert>}
              <Field label="Email" htmlFor="email" required>
                <TextInput
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                />
              </Field>
              <Field label="密碼" htmlFor="password" required>
                <TextInput
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Button type="submit" variant="primary" loading={busy === 'form'} disabled={!!busy} style={{ width: '100%' }}>
                登入
              </Button>
            </div>
          </form>
        </section>

        {demoAccounts.length > 0 && (
          <section className="card login-card">
            <h2 style={{ fontSize: 16, marginBottom: 4 }}>示範帳號一鍵登入</h2>
            <p className="muted small" style={{ marginBottom: 14 }}>
              密碼皆為 <span className="mono">{demoAccounts[0].password}</span>。可用不同角色測試權限與品牌隔離。
            </p>
            {demoAccounts.map((a) => (
              <button
                key={a.email}
                type="button"
                className="demo-account"
                disabled={!!busy}
                onClick={() => void doLogin(a.email, a.password, a.email)}
              >
                <Avatar name={a.name} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <strong>{a.name}</strong>
                    <Badge tone={ROLE_TONE[a.role]}>{ROLE_LABELS[a.role]}</Badge>
                  </span>
                  <span className="muted small truncate" style={{ display: 'block' }}>
                    {a.email}・{a.brandNames.join('、') || '尚未授權品牌'}
                  </span>
                </span>
                {busy === a.email && <span className="spinner" aria-hidden />}
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
