import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useBrandScope } from '../brand/BrandScope';
import { Avatar, Button, Dropdown, Select } from '../components/ui';
import { api } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import type { DemoAccountsResponse } from '../../../shared/types';
import { IconChevronDown, IconLogout, IconMenu } from '../components/icons';
import { NAV_SECTIONS } from './nav';
import { ROLE_LABELS } from '../../../shared/constants';

export function AppShell() {
  const { user, logout, login, can } = useAuth();
  const demo = useQuery(() => api.get<DemoAccountsResponse>('/auth/demo-accounts'), []);
  const demoAccounts = demo.data?.enabled ? demo.data.accounts : [];
  const { selected, setSelected, activeBrands } = useBrandScope();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => setNavOpen(false), [location.pathname]);
  if (!user) return null;

  const sections = NAV_SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => !i.perm || can(i.perm)) })).filter(
    (s) => s.items.length > 0,
  );

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar" aria-label="主選單">
        <div className="sidebar-brand">
          <span className="logo" aria-hidden>
            社
          </span>
          社群經營工作台
        </div>
        {sections.map((section, i) => (
          <nav key={section.title ?? i} aria-label={section.title ?? '工作'}>
            {section.title && <div className="nav-section">{section.title}</div>}
            {section.items.map((item) => (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                {item.icon}
                {item.label}
              </NavLink>
            ))}
          </nav>
        ))}
      </aside>
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} aria-hidden />

      <div className="main">
        <header className="topbar">
          <Button variant="ghost" iconOnly className="menu-toggle" aria-label="開啟選單" icon={<IconMenu />} onClick={() => setNavOpen(true)} />
          <label className="sr-only" htmlFor="brand-scope">
            切換品牌
          </label>
          <Select
            id="brand-scope"
            className="topbar-brand"
            value={String(selected)}
            onChange={(e) => setSelected(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          >
            <option value="all">全部負責品牌（{activeBrands.length}）</option>
            {activeBrands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <div className="spacer" />
          <Dropdown
            trigger={({ toggle, open }) => (
              <button
                className="btn btn-ghost topbar-user"
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`${user.name}（${ROLE_LABELS[user.role]}）的帳號選單`}
              >
                <Avatar name={user.name} size="sm" />
                <span className="nowrap topbar-user-name">{user.name}</span>
                <span className="muted small nowrap topbar-user-role">{ROLE_LABELS[user.role]}</span>
                <IconChevronDown size={14} />
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="menu-label">
                  {user.email}
                  <br />
                  {ROLE_LABELS[user.role]}
                </div>
                <div className="menu-sep" />
                {demoAccounts.length > 0 && (
                  <>
                    <div className="menu-label">切換示範帳號（測試用）</div>
                    {demoAccounts.map((a) => (
                      <button
                        key={a.email}
                        className="menu-item"
                        role="menuitem"
                        disabled={a.email === user.email}
                        onClick={async () => {
                          close();
                          await api.post('/auth/logout').catch(() => {});
                          await login(a.email, a.password);
                          navigate('/inbox', { replace: true });
                        }}
                      >
                        <Avatar name={a.name} size="sm" />
                        {a.name}
                        <span className="muted small">{ROLE_LABELS[a.role]}</span>
                      </button>
                    ))}
                    <div className="menu-sep" />
                  </>
                )}
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={async () => {
                    close();
                    await logout();
                    navigate('/login', { replace: true });
                  }}
                >
                  <IconLogout size={16} /> 登出
                </button>
              </>
            )}
          </Dropdown>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
