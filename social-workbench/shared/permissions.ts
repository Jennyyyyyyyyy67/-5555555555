import type { Role } from './constants';

// 角色權限表：前端用來決定顯示哪些選單／按鈕，後端用來實際擋 API。
// 品牌範圍（能看哪些品牌）另外由 user_brands 決定；管理員可存取所有品牌。
export const PERMISSIONS = {
  /** 新增、編輯、停用品牌 */
  manageBrands: ['admin'],
  /** 新增、編輯社群帳號、測試連線 */
  manageAccounts: ['admin'],
  /** 查看社群帳號（唯讀） */
  viewAccounts: ['admin', 'supervisor'],
  /** 新增、編輯人員、角色與授權品牌 */
  manageUsers: ['admin'],
  /** 查看負責品牌的人員（唯讀） */
  viewUsers: ['admin', 'supervisor'],
  /** 重設模擬資料、查看資料量 */
  manageMockData: ['admin'],
  /** 處理留言（回覆、變更狀態等） */
  handleComments: ['admin', 'supervisor', 'operator'],
  /** 重新指派負責人、強制接手處理中鎖定 */
  reassignComments: ['admin', 'supervisor'],
  overrideLock: ['admin', 'supervisor'],
  /** 留言類型、時效、AI 風格、自動化規則等設定 */
  manageSettings: ['admin'],
  /** 新增、修改、停用自動回覆規則 */
  manageAutomation: ['admin'],
  /** 查看自動回覆規則、用測試工具與模擬器試跑 */
  testAutomation: ['admin', 'supervisor'],
  /** 審核知識與回覆範例 */
  approveKnowledge: ['admin', 'supervisor'],
  /** 數據看板、報表 */
  viewDashboard: ['admin', 'supervisor'],
  /** 操作紀錄 */
  viewAuditLogs: ['admin', 'supervisor'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
