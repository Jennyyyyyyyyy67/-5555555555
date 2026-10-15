// 企業自助註冊：填公司名稱與負責人資料，建立專屬品牌後直接進入系統連結社群帳號。
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { MANUAL_LOGIN_KEY, useAuth } from '../auth/AuthContext';
import { api, ApiError, errorMessage } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { Alert, Button, Field, Loading, TextInput } from '../components/ui';
import { PASSWORD_MIN_LENGTH } from '../../../shared/constants';
import type { AuthConfigResponse, MeResponse, SignupInput } from '../../../shared/types';

type FieldKey = keyof SignupInput;

export default function SignupPage() {
  const { user, loading, applyMe } = useAuth();
  const navigate = useNavigate();
  const cfg = useQuery(() => api.get<AuthConfigResponse>('/auth/config'), []);
  const [form, setForm] = useState<SignupInput>({ companyName: '', name: '', email: '', password: '' });
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<Partial<Record<FieldKey | 'confirm', string>>>({});
  const [busy, setBusy] = useState(false);

  if (!loading && user && !busy) return <Navigate to="/inbox" replace />;
  if (cfg.loading && !cfg.data) return <Loading />;

  const set = (k: FieldKey, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof fieldErr = {};
    if (!form.companyName.trim()) errs.companyName = '請輸入公司或品牌名稱';
    if (!form.name.trim()) errs.name = '請輸入你的名字';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) errs.email = 'Email 格式不正確';
    if (form.password.length < PASSWORD_MIN_LENGTH) errs.password = `密碼至少 ${PASSWORD_MIN_LENGTH} 個字`;
    if (confirm !== form.password) errs.confirm = '兩次輸入的密碼不一樣';
    setFieldErr(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      const me = await api.post<MeResponse>('/auth/signup', form);
      try {
        sessionStorage.setItem(MANUAL_LOGIN_KEY, '1');
      } catch {
        /* 忽略 */
      }
      applyMe(me);
      navigate('/settings/accounts?welcome=1', { replace: true });
    } catch (err) {
      const field = err instanceof ApiError ? (err.details as { field?: FieldKey } | undefined)?.field : undefined;
      if (field) setFieldErr({ [field]: errorMessage(err) });
      else setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-wrap" style={{ maxWidth: 460 }}>
        <section className="card login-card">
          <div className="login-title">
            <span className="avatar" style={{ background: 'linear-gradient(135deg,#3355d6,#7b4fe0)', borderRadius: 10 }} aria-hidden>
              社
            </span>
            <div>
              <h1>註冊企業帳號</h1>
              <p className="muted small">建立帳號後，連結你的 Instagram，就能自動回覆留言。</p>
            </div>
          </div>
          {cfg.data && !cfg.data.signupEnabled ? (
            <Alert tone="warning">目前未開放註冊，請聯絡系統管理員開通帳號。</Alert>
          ) : (
            <form onSubmit={submit} noValidate>
              <div className="stack">
                {error && <Alert tone="danger">{error}</Alert>}
                <Field label="公司／品牌名稱" htmlFor="su-company" required error={fieldErr.companyName}>
                  <TextInput id="su-company" value={form.companyName} maxLength={40} onChange={(e) => set('companyName', e.target.value)} placeholder="例如：J甄舞蹈" invalid={!!fieldErr.companyName} />
                </Field>
                <Field label="你的名字" htmlFor="su-name" required error={fieldErr.name}>
                  <TextInput id="su-name" value={form.name} maxLength={40} onChange={(e) => set('name', e.target.value)} invalid={!!fieldErr.name} />
                </Field>
                <Field label="Email（登入用）" htmlFor="su-email" required error={fieldErr.email}>
                  <TextInput id="su-email" type="email" autoComplete="username" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="name@company.com" invalid={!!fieldErr.email} />
                </Field>
                <Field label="密碼" htmlFor="su-pw" required error={fieldErr.password} hint={`至少 ${PASSWORD_MIN_LENGTH} 個字`}>
                  <TextInput id="su-pw" type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} invalid={!!fieldErr.password} />
                </Field>
                <Field label="再輸入一次密碼" htmlFor="su-pw2" required error={fieldErr.confirm}>
                  <TextInput id="su-pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={!!fieldErr.confirm} />
                </Field>
                <Button type="submit" variant="primary" loading={busy} style={{ width: '100%' }}>
                  建立帳號
                </Button>
                <p className="small muted" style={{ margin: 0, textAlign: 'center' }}>
                  註冊即表示同意<a href="/privacy.html" target="_blank" rel="noreferrer">隱私權政策</a>。已經有帳號？<Link to="/login">登入</Link>
                </p>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
