import { Router } from 'express';
import { requireAuth } from '../auth/middleware';
import { authRoutes } from './auth';
import { metaRoutes } from './meta';
import { brandRoutes } from './brands';
import { accountRoutes } from './accounts';
import { userRoutes } from './users';
import { mockRoutes } from './mock';
import { commentRoutes } from './comments';
import { auditRoutes } from './audit';
import { automationRoutes } from './automation';
import { notificationRoutes } from './inbox';
import { brandCategorySettingRoutes, categoryRoutes } from './categories';
import { integrationRoutes, webhookRoutes } from './integrations';
import { knowledgeRoutes } from './knowledge';
import { signupRoutes } from './signup';
import { styleRoutes } from './style';
import { batchRoutes } from './batch';
import { analyticsRoutes } from './analytics';
import { cannedReplyRoutes, replyExampleRoutes } from './library';

/** 所有 API 路由。除了 /auth 之外都需要登入；更細的角色與品牌權限由各路由自行檢查。 */
export function apiRouter(): Router {
  const r = Router();
  r.use('/auth', authRoutes());
  r.use('/auth', signupRoutes());
  r.use('/webhooks', webhookRoutes());
  r.use('/integrations', integrationRoutes());
  r.use('/meta', requireAuth(), metaRoutes());
  r.use('/brands/:id/category-settings', requireAuth(), brandCategorySettingRoutes());
  r.use('/brands/:id/style', requireAuth(), styleRoutes());
  r.use('/knowledge', requireAuth(), knowledgeRoutes());
  r.use('/canned-replies', requireAuth(), cannedReplyRoutes());
  r.use('/reply-examples', requireAuth(), replyExampleRoutes());
  r.use('/brands', requireAuth(), brandRoutes());
  r.use('/categories', requireAuth(), categoryRoutes());
  r.use('/accounts', requireAuth(), accountRoutes());
  r.use('/users', requireAuth(), userRoutes());
  r.use('/mock', requireAuth(), mockRoutes());
  r.use('/comments', requireAuth(), commentRoutes());
  r.use('/audit', requireAuth(), auditRoutes());
  r.use('/automation', requireAuth(), automationRoutes());
  r.use('/batch', requireAuth(), batchRoutes());
  r.use('/analytics', requireAuth(), analyticsRoutes());
  r.use('/notifications', requireAuth(), notificationRoutes());
  return r;
}
