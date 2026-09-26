import { Request, Response, NextFunction } from 'express';
import { query } from '../db.js';

/**
 * Express middleware that logs every API request to the api_request_logs table.
 * Non-blocking — errors are silently ignored so the main request never fails.
 */
export function apiMonitor(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const env = process.env.NODE_ENV || 'development';

  res.on('finish', () => {
    const ms = Date.now() - start;
    const userId = (req as any).user?.id || null;

    // Skip health-check noise
    if (req.path === '/health' || req.path === '/api/health') {
      return;
    }

    query(
      `INSERT INTO api_request_logs (id, method, path, status_code, response_time_ms, user_id, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        crypto.randomUUID(),
        req.method,
        req.path,
        res.statusCode,
        ms,
        userId,
        env,
      ]
    ).catch(() => {}); // silent — never block the request
  });

  next();
}
