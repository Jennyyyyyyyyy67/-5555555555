import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { DB } from '../db';
import { SESSION_COOKIE } from '../config';
import { getSessionUser, type AuthUser } from './session';
import { computeScope, type BrandScope } from './scope';
import { forbidden, unauthorized } from '../lib/errors';
import { can, type Permission } from '../../shared/permissions';

declare module 'express-serve-static-core' {
  interface Request {
    db: DB;
    user?: AuthUser;
    scope?: BrandScope;
    sessionToken?: string;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** 讀取 cookie 中的登入狀態，存在則掛上 req.user 與 req.scope（不強制登入） */
export function loadUser(): RequestHandler {
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = getSessionUser(req.db, token);
    if (user) {
      req.user = user;
      req.sessionToken = token;
      req.scope = computeScope(req.db, user);
    }
    next();
  };
}

export function requireAuth(): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || !req.scope) return next(unauthorized());
    next();
  };
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || !req.scope) return next(unauthorized());
    if (!can(req.user.role, permission)) return next(forbidden());
    next();
  };
}

/** 在已通過 requireAuth 的路由中取得登入者與範圍（型別保證非空） */
export function authed(req: Request): { user: AuthUser; scope: BrandScope } {
  if (!req.user || !req.scope) throw unauthorized();
  return { user: req.user, scope: req.scope };
}

export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
