import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui';
import { useAuth } from '../auth/AuthContext';
import type { Permission } from '../../../shared/permissions';
import type { ReactNode } from 'react';

export function NotFoundPage() {
  return <EmptyState title="找不到這個頁面" description="網址可能有誤，或頁面已移除。" action={<Link to="/inbox">回到收件匣</Link>} />;
}

export function ForbiddenPage() {
  return <EmptyState title="你沒有權限查看這個頁面" description="如需存取，請聯絡管理員調整你的角色或授權品牌。" action={<Link to="/inbox">回到收件匣</Link>} />;
}

/** 頁面層級的權限檢查（API 也會再檢查一次） */
export function RequirePermission({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { can } = useAuth();
  return can(perm) ? <>{children}</> : <ForbiddenPage />;
}
