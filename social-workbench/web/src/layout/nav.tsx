import type { ReactNode } from 'react';
import type { Permission } from '../../../shared/permissions';
import { IconAlert, IconBolt, IconBulb, IconChart, IconHistory, IconLayers, IconReport, IconBook, IconSparkle, IconBuilding, IconClock, IconDatabase, IconInbox, IconLink, IconUsers, IconChat } from '../components/icons';

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
    items: [
      { to: '/inbox', label: '收件匣', icon: <IconInbox /> },
      { to: '/batch', label: '相似留言', icon: <IconLayers /> },
    ],
  },
  {
    title: 'AI 與自動化',
    items: [
      { to: '/knowledge', label: '知識庫', icon: <IconBook /> },
      { to: '/library', label: '回覆範本', icon: <IconChat /> },
      { to: '/settings/style', label: 'AI 回覆風格', icon: <IconSparkle />, perm: 'viewAccounts' },
      { to: '/automation', label: '自動回覆', icon: <IconBolt />, perm: 'testAutomation' },
    ],
  },
  {
    title: '數據與報表',
    items: [
      { to: '/dashboard', label: '數據看板', icon: <IconChart />, perm: 'viewDashboard' },
      { to: '/anomalies', label: '異常事件', icon: <IconAlert />, perm: 'viewDashboard' },
      { to: '/insights', label: '社群洞察', icon: <IconBulb />, perm: 'viewDashboard' },
      { to: '/reports', label: '報表', icon: <IconReport />, perm: 'viewDashboard' },
      { to: '/audit', label: '操作紀錄', icon: <IconHistory />, perm: 'viewAuditLogs' },
    ],
  },
  {
    title: '設定',
    items: [
      { to: '/settings/brands', label: '品牌管理', icon: <IconBuilding />, perm: 'manageBrands' },
      { to: '/settings/accounts', label: '社群帳號', icon: <IconLink />, perm: 'viewAccounts' },
      { to: '/settings/categories', label: '留言類型與時效', icon: <IconClock />, perm: 'viewAccounts' },
      { to: '/settings/users', label: '人員與權限', icon: <IconUsers />, perm: 'viewUsers' },
      { to: '/settings/mock', label: '模擬資料', icon: <IconDatabase />, perm: 'manageMockData' },
    ],
  },
];
