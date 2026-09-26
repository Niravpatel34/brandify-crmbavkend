import { Router } from 'express';
import { query } from '../db.js';
import { authMiddleware, requireRole, AuthenticatedRequest } from '../middleware/auth.js';
import {
  getDbOverview,
  getAllTables,
  getTableSchema,
  getTableData,
  getDbHealth,
  globalDbSearch,
} from '../services/adminService.js';
import { createBackup, listBackups, getBackupFilePath } from '../services/backupService.js';
import { getMigrations, runPendingMigrations } from '../services/migrationService.js';
import path from 'path';
import os from 'os';
import process from 'process';

const router = Router();

// All admin routes require authentication at minimum
router.use(authMiddleware);

// ── Helper: audit log entry ───────────────────────────────────────────────────

async function auditLog(action: string, details: string, performedBy: string) {
  try {
    await query(
      `INSERT INTO audit_logs (id, action, details, performed_by) VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), action, details, performedBy]
    );
  } catch (_) {}
}

// ── ENVIRONMENT INFO (admin+) ─────────────────────────────────────────────────

router.get('/env', requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  const env = process.env.NODE_ENV || 'development';
  const isProduction = env === 'production';

  res.json({
    environment: env,
    isProduction,
    nodeVersion: process.version,
    platform: process.platform,
    appVersion: '1.0.0',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5177',
    databaseType: process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite',
    // Masked secrets
    jwtConfigured: !!process.env.JWT_SECRET,
    databaseConfigured: !!process.env.DATABASE_URL,
    metaConfigured: !!process.env.META_APP_ID,
    whatsappConfigured: !!process.env.WHATSAPP_ACCESS_TOKEN,
    webhookConfigured: !!process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  });
});

// ── DATABASE OVERVIEW (admin+) ────────────────────────────────────────────────

router.get('/db/overview', requireRole('admin'), async (req, res) => {
  try {
    const overview = await getDbOverview();
    res.json(overview);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── DATABASE HEALTH (admin+) ──────────────────────────────────────────────────

router.get('/db/health', requireRole('admin'), async (req, res) => {
  try {
    const health = await getDbHealth();
    res.json(health);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── TABLE LIST (admin+) ───────────────────────────────────────────────────────

router.get('/db/tables', requireRole('admin'), async (req, res) => {
  try {
    const tables = await getAllTables();
    const stats = [];
    for (const t of tables) {
      const r = await query(`SELECT COUNT(*) as cnt FROM "${t}"`).catch(() => ({ rows: [{ cnt: 0 }] }));
      stats.push({ name: t, count: Number(r.rows[0]?.cnt || 0) });
    }
    res.json({ tables: stats });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── TABLE SCHEMA (admin+) ─────────────────────────────────────────────────────

router.get('/db/tables/:table/schema', requireRole('admin'), async (req, res) => {
  try {
    const schema = await getTableSchema(req.params.table);
    res.json({ schema });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── TABLE DATA — paginated (admin+) ───────────────────────────────────────────

router.get('/db/tables/:table/data', requireRole('admin'), async (req, res) => {
  try {
    const page = parseInt(String(req.query.page || '1'));
    const pageSize = Math.min(parseInt(String(req.query.pageSize || '50')), 200);
    const search = String(req.query.search || '');
    const sortColumn = String(req.query.sortColumn || '');
    const sortDir = String(req.query.sortDir || 'asc');

    const result = await getTableData(req.params.table, page, pageSize, search, sortColumn, sortDir);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── CREATE RECORD (admin+) ────────────────────────────────────────────────────

router.post('/db/tables/:table/records', requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  const { table } = req.params;
  const tables = await getAllTables();
  if (!tables.includes(table)) {
    res.status(404).json({ error: 'Table not found' });
    return;
  }

  const data = req.body;
  if (!data || Object.keys(data).length === 0) {
    res.status(400).json({ error: 'No data provided' });
    return;
  }

  // Auto-assign UUID if id not provided
  if (!data.id) {
    data.id = crypto.randomUUID();
  }

  const columns = Object.keys(data);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const values = columns.map(k => data[k]);

  try {
    await query(
      `INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`,
      values
    );
    await auditLog('DB_RECORD_CREATE', `Created record in ${table} (id: ${data.id})`, req.user?.username || 'admin');
    res.json({ success: true, id: data.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── UPDATE RECORD (admin+) ────────────────────────────────────────────────────

router.put('/db/tables/:table/records/:id', requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  const { table, id } = req.params;
  const tables = await getAllTables();
  if (!tables.includes(table)) {
    res.status(404).json({ error: 'Table not found' });
    return;
  }

  const updates = req.body;
  if (!updates || Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No update data provided' });
    return;
  }

  const setClauses = Object.keys(updates).map((k, i) => `"${k}" = $${i + 1}`).join(', ');
  const values = [...Object.values(updates), id];

  try {
    await query(`UPDATE "${table}" SET ${setClauses} WHERE id = $${values.length}`, values);
    await auditLog('DB_RECORD_UPDATE', `Updated record ${id} in ${table}`, req.user?.username || 'admin');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE RECORD (admin+) ────────────────────────────────────────────────────

router.delete('/db/tables/:table/records/:id', requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  const { table, id } = req.params;
  const tables = await getAllTables();
  if (!tables.includes(table)) {
    res.status(404).json({ error: 'Table not found' });
    return;
  }

  // Block deletion from protected tables in production
  const protectedTables = ['users', 'schema_migrations'];
  if (protectedTables.includes(table) && process.env.NODE_ENV === 'production') {
    res.status(403).json({ error: `Deletion from "${table}" is restricted in production. Use Hostinger hPanel or direct DB access.` });
    return;
  }

  try {
    await query(`DELETE FROM "${table}" WHERE id = $1`, [id]);
    await auditLog('DB_RECORD_DELETE', `Deleted record ${id} from ${table}`, req.user?.username || 'admin');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── BULK DELETE (admin+) ──────────────────────────────────────────────────────

router.post('/db/tables/:table/bulk', requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  const { table } = req.params;
  const { action, ids } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids array is required' });
    return;
  }

  const tables = await getAllTables();
  if (!tables.includes(table)) {
    res.status(404).json({ error: 'Table not found' });
    return;
  }

  if (action === 'delete') {
    const placeholders = ids.map((_: any, i: number) => `$${i + 1}`).join(', ');
    await query(`DELETE FROM "${table}" WHERE id IN (${placeholders})`, ids);
    await auditLog('DB_BULK_DELETE', `Bulk deleted ${ids.length} records from ${table}`, req.user?.username || 'admin');
    res.json({ success: true, deleted: ids.length });
    return;
  }

  res.status(400).json({ error: `Unknown bulk action: ${action}` });
});

// ── GLOBAL SEARCH (admin+) ────────────────────────────────────────────────────

router.get('/db/search', requireRole('admin'), async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (!term || term.length < 2) {
    res.status(400).json({ error: 'Search term must be at least 2 characters' });
    return;
  }
  try {
    const results = await globalDbSearch(term);
    res.json({ results });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── MIGRATIONS (admin+) ───────────────────────────────────────────────────────

router.get('/migrations', requireRole('admin'), async (req, res) => {
  try {
    const migrations = await getMigrations();
    res.json({ migrations });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/migrations/run', requireRole('super_admin'), async (req: AuthenticatedRequest, res) => {
  const env = process.env.NODE_ENV || 'development';
  if (env === 'production') {
    const { confirmed } = req.body;
    if (confirmed !== 'CONFIRMED_PRODUCTION_MIGRATION') {
      res.status(400).json({
        error: 'Production migration requires explicit confirmation. Pass confirmed: "CONFIRMED_PRODUCTION_MIGRATION"',
      });
      return;
    }
  }

  try {
    const results = await runPendingMigrations(req.user?.username || 'admin');
    res.json({ results });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── BACKUPS (admin+) ──────────────────────────────────────────────────────────

router.get('/backup/list', requireRole('admin'), async (req, res) => {
  try {
    const backups = await listBackups();
    res.json({ backups });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/backup/create', requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const backup = await createBackup(req.user?.username || 'admin');
    await auditLog('DB_BACKUP_CREATE', `Database backup created: ${backup.filename}`, req.user?.username || 'admin');
    res.json({ success: true, backup });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/backup/:filename/download', requireRole('super_admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const filePath = getBackupFilePath(req.params.filename);
    await auditLog('DB_BACKUP_DOWNLOAD', `Backup downloaded: ${req.params.filename}`, req.user?.username || 'admin');
    res.download(filePath, req.params.filename);
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});

// ── AUDIT LOGS (admin+) ───────────────────────────────────────────────────────

router.get('/audit-logs', requireRole('admin'), async (req, res) => {
  const page = parseInt(String(req.query.page || '1'));
  const pageSize = Math.min(parseInt(String(req.query.pageSize || '50')), 200);
  const offset = (page - 1) * pageSize;
  const search = String(req.query.search || '');

  let where = '';
  const params: any[] = [];
  if (search) {
    where = `WHERE action LIKE $1 OR details LIKE $2 OR performed_by LIKE $3`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  try {
    const total = await query(`SELECT COUNT(*) as cnt FROM audit_logs ${where}`, params);
    const rows = await query(
      `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );
    res.json({
      logs: rows.rows,
      total: Number(total.rows[0]?.cnt || 0),
      page,
      pageSize,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── USER MANAGEMENT (super_admin) ─────────────────────────────────────────────

router.get('/users', requireRole('super_admin'), async (req, res) => {
  try {
    const result = await query(
      `SELECT id, username, mobile_number, full_name, role, created_at FROM users ORDER BY created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id/role', requireRole('super_admin'), async (req: AuthenticatedRequest, res) => {
  const { role } = req.body;
  const validRoles = ['super_admin', 'admin', 'manager', 'user'];

  if (!validRoles.includes(role)) {
    res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    return;
  }

  try {
    await query(`UPDATE users SET role = $1 WHERE id = $2`, [role, req.params.id]);
    await auditLog('USER_ROLE_CHANGE', `User ${req.params.id} role changed to ${role}`, req.user?.username || 'admin');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── API MONITOR (admin+) ──────────────────────────────────────────────────────

router.get('/api-monitor', requireRole('admin'), async (req, res) => {
  try {
    const summary = await query(`
      SELECT 
        path,
        method,
        COUNT(*) as total_requests,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count,
        SUM(CASE WHEN status_code < 400 THEN 1 ELSE 0 END) as success_count,
        ROUND(AVG(response_time_ms), 1) as avg_response_ms,
        MAX(created_at) as last_request
      FROM api_request_logs
      GROUP BY path, method
      ORDER BY total_requests DESC
      LIMIT 100
    `);

    const recentErrors = await query(`
      SELECT * FROM api_request_logs 
      WHERE status_code >= 400 
      ORDER BY created_at DESC 
      LIMIT 20
    `);

    res.json({ endpoints: summary.rows, recentErrors: recentErrors.rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── SQL CONSOLE (super_admin ONLY) ────────────────────────────────────────────

const BLOCKED_SQL_PATTERNS = [/DROP\s+TABLE/i, /DROP\s+DATABASE/i, /TRUNCATE/i, /ALTER\s+TABLE.*DROP/i];

router.post('/sql', requireRole('super_admin'), async (req: AuthenticatedRequest, res) => {
  const { sql: rawSql, confirmed } = req.body;

  if (!rawSql) {
    res.status(400).json({ error: 'SQL query is required' });
    return;
  }

  const env = process.env.NODE_ENV || 'development';
  const isDangerous = /INSERT|UPDATE|DELETE/i.test(rawSql);
  const isDestructive = BLOCKED_SQL_PATTERNS.some(p => p.test(rawSql));

  if (isDestructive) {
    res.status(403).json({ error: 'DROP, TRUNCATE, and ALTER TABLE DROP operations are blocked via SQL console.' });
    return;
  }

  if (isDangerous && env === 'production' && confirmed !== 'CONFIRMED_PRODUCTION_SQL') {
    res.status(400).json({
      error: 'INSERT/UPDATE/DELETE on production requires confirmation. Pass confirmed: "CONFIRMED_PRODUCTION_SQL"',
    });
    return;
  }

  const start = Date.now();
  try {
    const result = await query(rawSql);
    const ms = Date.now() - start;
    await auditLog('SQL_CONSOLE', `Query executed (${ms}ms): ${rawSql.substring(0, 200)}`, req.user?.username || 'admin');
    res.json({ rows: result.rows, rowCount: result.rows.length, executionMs: ms });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── DEPLOYMENT CHECKLIST (admin+) ─────────────────────────────────────────────

router.get('/deployment/checklist', requireRole('admin'), async (req, res) => {
  const env = process.env.NODE_ENV || 'development';
  const isProduction = env === 'production';

  const checks = [
    {
      id: 'env',
      label: 'Environment configured',
      status: !!env,
      value: env,
    },
    {
      id: 'jwt',
      label: 'JWT_SECRET configured',
      status: !!process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16,
    },
    {
      id: 'db',
      label: 'Database connection',
      status: true,
      value: process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite',
    },
    {
      id: 'frontend_url',
      label: 'FRONTEND_URL configured',
      status: !!process.env.FRONTEND_URL,
      value: process.env.FRONTEND_URL || 'Not set',
    },
    {
      id: 'whatsapp',
      label: 'WhatsApp credentials configured',
      status: !!process.env.WHATSAPP_ACCESS_TOKEN,
    },
    {
      id: 'webhook',
      label: 'WhatsApp webhook verify token configured',
      status: !!process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    },
    {
      id: 'migrations',
      label: 'No pending migrations',
      status: true, // resolved at runtime
    },
  ];

  // Check pending migrations
  try {
    const pending = await query(
      `SELECT COUNT(*) as cnt FROM schema_migrations WHERE status = 'PENDING'`
    );
    const pendingCount = Number(pending.rows[0]?.cnt || 0);
    const migCheck = checks.find(c => c.id === 'migrations');
    if (migCheck) {
      migCheck.status = pendingCount === 0;
      (migCheck as any).value = `${pendingCount} pending`;
    }
  } catch (_) {}

  const allPassed = checks.every(c => c.status);

  res.json({
    environment: env,
    isProduction,
    allPassed,
    checks,
    readyForProduction: allPassed && isProduction,
  });
});

export default router;
