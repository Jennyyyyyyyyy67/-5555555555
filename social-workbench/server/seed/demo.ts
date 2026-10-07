// 示範帳號與示範品牌的基本定義（登入頁「示範帳號一鍵登入」與示範資料共用）。
import type { Role } from '../../shared/constants';

export const DEMO_PASSWORD = 'demo1234';

export interface DemoBrandDef {
  code: string;
  name: string;
  color: string;
  description: string;
}

export const DEMO_BRANDS: DemoBrandDef[] = [
  {
    code: 'CLEAR',
    name: '澄淨家電',
    color: '#0e7490',
    description: '淨水器、濾芯與氣泡水機品牌。回覆風格專業、穩重、清楚。',
  },
  {
    code: 'DAILY',
    name: '日日咖啡',
    color: '#b45309',
    description: '咖啡豆、掛耳包與手沖器材，另有兩家實體門市。回覆風格活潑親切。',
  },
  {
    code: 'MORI',
    name: '小森嬰品',
    color: '#15803d',
    description: '奶瓶、副食品器具與背巾等嬰幼兒用品。回覆風格溫柔謹慎，安全議題一律由人工處理。',
  },
];

export interface DemoUserDef {
  email: string;
  name: string;
  role: Role;
  /** 授權品牌（以品牌代碼表示）；管理員為空陣列，代表全部品牌 */
  brandCodes: string[];
}

export const DEMO_USERS: DemoUserDef[] = [
  { email: 'admin@demo.tw', name: '林思妤', role: 'admin', brandCodes: [] },
  { email: 'lead@demo.tw', name: '陳柏翰', role: 'supervisor', brandCodes: ['CLEAR', 'DAILY'] },
  { email: 'amy@demo.tw', name: '王小美', role: 'operator', brandCodes: ['CLEAR', 'DAILY'] },
  { email: 'hao@demo.tw', name: '張家豪', role: 'operator', brandCodes: ['DAILY', 'MORI'] },
];
