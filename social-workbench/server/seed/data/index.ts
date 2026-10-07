import type { BrandScript } from './types';
import { CLEAR_SCRIPT } from './clear';
import { DAILY_SCRIPT } from './daily';
import { MORI_SCRIPT } from './mori';

export { BRAND_SETTINGS, LAST_LOGIN_AGO } from './brandSettings';
export type { BrandScript, CommentSeed, Flow, UserKey } from './types';

/** 三個示範品牌的劇本（品牌代碼需對應 DEMO_BRANDS） */
export const BRAND_SCRIPTS: BrandScript[] = [CLEAR_SCRIPT, DAILY_SCRIPT, MORI_SCRIPT];
