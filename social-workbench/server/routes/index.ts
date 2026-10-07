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

/** 所有 API 路由。除了 /auth 之外都需要登入；更細的角色與品牌權限由各路由自行檢查。 */
export function apiRouter(): Router {
  const r = Router();
  r.use('/auth', authRoutes());
  r.use('/meta', requireAuth(), metaRoutes());
  r.use('/brands', requireAuth(), brandRoutes());
  r.use('/accounts', requireAuth(), accountRoutes());
  r.use('/users', requireAuth(), userRoutes());
  r.use('/mock', requireAuth(), mockRoutes());
  r.use('/comments', requireAuth(), commentRoutes());
  r.use('/audit', requireAuth(), auditRoutes());
  return r;
}
