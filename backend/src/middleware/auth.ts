import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    role: string;
  };
}

const JWT_SECRET = process.env.JWT_SECRET || 'brandify_outreach_secret_key_2026';

// Role hierarchy: super_admin > admin > manager > user
const ROLE_LEVELS: Record<string, number> = {
  super_admin: 100,
  admin: 50,
  manager: 25,
  user: 10,
};

export function getRoleLevel(role: string): number {
  return ROLE_LEVELS[role] ?? 0;
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: 'Authorization header missing' });
    return;
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: 'Bearer token missing' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: string;
      username: string;
      role: string;
    };
    req.user = decoded;
    next();
  } catch (error) {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
}

/** Middleware factory — requires minimum role level to access route */
export function requireRole(minimumRole: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const userLevel = getRoleLevel(req.user.role);
    const requiredLevel = getRoleLevel(minimumRole);
    if (userLevel < requiredLevel) {
      res.status(403).json({
        error: `Insufficient permissions. Required role: ${minimumRole}`,
        yourRole: req.user.role,
      });
      return;
    }
    next();
  };
}
