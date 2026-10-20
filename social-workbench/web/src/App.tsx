import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/AuthContext';
import { BrandScopeProvider } from './brand/BrandScope';
import { MetaProvider } from './lib/meta';
import { AppShell } from './layout/AppShell';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import { NotFoundPage, RequirePermission } from './pages/StatusPages';
import InboxPage from './pages/inbox/InboxPage';
import BrandsPage from './pages/settings/BrandsPage';
import AccountsPage from './pages/settings/AccountsPage';
import UsersPage from './pages/settings/UsersPage';
import MockDataPage from './pages/settings/MockDataPage';
import AutomationPage from './pages/automation/AutomationPage';
import CategoriesPage from './pages/settings/CategoriesPage';
import KnowledgePage from './pages/knowledge/KnowledgePage';
import BatchPage from './pages/batch/BatchPage';
import DashboardPage from './pages/analytics/DashboardPage';
import AnomaliesPage from './pages/analytics/AnomaliesPage';
import InsightsPage from './pages/analytics/InsightsPage';
import ReportsPage from './pages/analytics/ReportsPage';
import AuditPage from './pages/analytics/AuditPage';
import StylePage from './pages/settings/StylePage';
import LibraryPage from './pages/library/LibraryPage';
import SetupPage from './pages/settings/SetupPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
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
        <Route path="/inbox/:id" element={<InboxPage />} />
        <Route path="/batch" element={<BatchPage />} />
        <Route path="/dashboard" element={<RequirePermission perm="viewDashboard"><DashboardPage /></RequirePermission>} />
        <Route path="/anomalies" element={<RequirePermission perm="viewDashboard"><AnomaliesPage /></RequirePermission>} />
        <Route path="/insights" element={<RequirePermission perm="viewDashboard"><InsightsPage /></RequirePermission>} />
        <Route path="/reports" element={<RequirePermission perm="viewDashboard"><ReportsPage /></RequirePermission>} />
        <Route path="/audit" element={<RequirePermission perm="viewAuditLogs"><AuditPage /></RequirePermission>} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/setup" element={<RequirePermission perm="manageSettings"><SetupPage /></RequirePermission>} />
        <Route path="/settings/style" element={<RequirePermission perm="viewAccounts"><StylePage /></RequirePermission>} />
        <Route path="/automation" element={<RequirePermission perm="testAutomation"><AutomationPage /></RequirePermission>} />
        <Route path="/settings/brands" element={<RequirePermission perm="manageBrands"><BrandsPage /></RequirePermission>} />
        <Route path="/settings/accounts" element={<RequirePermission perm="viewAccounts"><AccountsPage /></RequirePermission>} />
        <Route path="/settings/users" element={<RequirePermission perm="viewUsers"><UsersPage /></RequirePermission>} />
        <Route path="/settings/categories" element={<RequirePermission perm="viewAccounts"><CategoriesPage /></RequirePermission>} />
        <Route path="/settings/mock" element={<RequirePermission perm="manageMockData"><MockDataPage /></RequirePermission>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
