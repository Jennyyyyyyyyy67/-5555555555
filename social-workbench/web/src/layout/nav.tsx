import type { ReactNode } from 'react';
import type { Permission } from '../../../shared/permissions';
import { IconBuilding, IconDatabase, IconInbox, IconLink, IconUsers } from '../components/icons';

export interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  /** 需要的權限；未設定代表所有登入者都可看到 */
  perm?: Permission;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

// 側欄選單。只列出已完成的功能，避免堆積用不到的入口。
export const NAV_SECTIONS: NavSection[] = [
  {
    items: [{ to: '/inbox', label: '收件匣', icon: <IconInbox /> }],
  },
  {
    title: '設定',
    items: [
      { to: '/settings/brands', label: '品牌管理', icon: <IconBuilding />, perm: 'manageBrands' },
      { to: '/settings/accounts', label: '社群帳號', icon: <IconLink />, perm: 'viewAccounts' },
      { to: '/settings/users', label: '人員與權限', icon: <IconUsers />, perm: 'viewUsers' },
      { to: '/settings/mock', label: '模擬資料', icon: <IconDatabase />, perm: 'manageMockData' },
    ],
  },
];
