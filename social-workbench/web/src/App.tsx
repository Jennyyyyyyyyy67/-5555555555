import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/AuthContext';
import { BrandScopeProvider } from './brand/BrandScope';
import { MetaProvider } from './lib/meta';
import { AppShell } from './layout/AppShell';
import LoginPage from './pages/LoginPage';
import { NotFoundPage, RequirePermission } from './pages/StatusPages';
import InboxPage from './pages/inbox/InboxPage';
import BrandsPage from './pages/settings/BrandsPage';
import AccountsPage from './pages/settings/AccountsPage';
import UsersPage from './pages/settings/UsersPage';
import MockDataPage from './pages/settings/MockDataPage';
import AutomationPage from './pages/automation/AutomationPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <MetaProvider>
              <BrandScopeProvider>
                <AppShell />
              </BrandScopeProvider>
            </MetaProvider>
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/inbox" replace />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/automation" element={<RequirePermission perm="testAutomation"><AutomationPage /></RequirePermission>} />
        <Route path="/settings/brands" element={<RequirePermission perm="manageBrands"><BrandsPage /></RequirePermission>} />
        <Route path="/settings/accounts" element={<RequirePermission perm="viewAccounts"><AccountsPage /></RequirePermission>} />
        <Route path="/settings/users" element={<RequirePermission perm="viewUsers"><UsersPage /></RequirePermission>} />
        <Route path="/settings/mock" element={<RequirePermission perm="manageMockData"><MockDataPage /></RequirePermission>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
