import { query } from '../db.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Database Overview ─────────────────────────────────────────────────────────

export async function getDbOverview() {
  const env = process.env.NODE_ENV || 'development';
  const isPostgres = !!process.env.DATABASE_URL;
  const dbType = isPostgres ? 'PostgreSQL' : 'SQLite';

  // Ping time
  const pingStart = Date.now();
  try {
    await query('SELECT 1');
  } catch (e) {}
  const pingMs = Date.now() - pingStart;

  // Table list & record counts
  const tables = await getAllTables();
  const totalTables = tables.length;
  let totalRecords = 0;
  const tableStats: Array<{ name: string; count: number }> = [];

  for (const t of tables) {
    try {
      const r = await query(`SELECT COUNT(*) as cnt FROM "${t}"`);
      const cnt = Number(r.rows[0]?.cnt || 0);
      totalRecords += cnt;
      tableStats.push({ name: t, count: cnt });
    } catch (_) {
      tableStats.push({ name: t, count: 0 });
    }
  }

  // DB file size (SQLite only)
  let dbSizeBytes = 0;
  if (!isPostgres) {
    const dbPath = path.resolve(__dirname, '../../../outreach.db');
    try {
      const stat = fs.statSync(dbPath);
      dbSizeBytes = stat.size;
    } catch (_) {}
  }

  // Pending migrations
  let pendingMigrations = 0;
  try {
    const migs = await query(`SELECT COUNT(*) as cnt FROM schema_migrations WHERE status = 'PENDING'`);
    pendingMigrations = Number(migs.rows[0]?.cnt || 0);
  } catch (_) {}

  return {
    environment: env,
    dbType,
    isPostgres,
    status: 'connected',
    pingMs,
    totalTables,
    totalRecords,
    tables: tableStats,
    dbSizeBytes,
    pendingMigrations,
  };
}

// ── Table List ────────────────────────────────────────────────────────────────

export async function getAllTables(): Promise<string[]> {
  const isPostgres = !!process.env.DATABASE_URL;
  if (isPostgres) {
    const r = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    return r.rows.map((row: any) => row.table_name);
  } else {
    const r = await query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    return r.rows.map((row: any) => row.name);
  }
}

// ── Table Schema ──────────────────────────────────────────────────────────────

export async function getTableSchema(tableName: string) {
  const isPostgres = !!process.env.DATABASE_URL;

  if (isPostgres) {
    const cols = await query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
    );
    return cols.rows;
  } else {
    // SQLite PRAGMA
    const cols = await query(`PRAGMA table_info("${tableName}")`);
    return cols.rows.map((c: any) => ({
      column_name: c.name,
      data_type: c.type || 'TEXT',
      is_nullable: c.notnull ? 'NO' : 'YES',
      column_default: c.dflt_value,
      primary_key: c.pk === 1,
    }));
  }
}

// ── Paginated Table Data ──────────────────────────────────────────────────────

export async function getTableData(
  tableName: string,
  page: number = 1,
  pageSize: number = 50,
  search: string = '',
  sortColumn: string = '',
  sortDir: string = 'asc'
) {
  const offset = (page - 1) * pageSize;

  // Validate table name to prevent SQL injection (whitelist from actual tables)
  const tables = await getAllTables();
  if (!tables.includes(tableName)) {
    throw new Error(`Table "${tableName}" not found`);
  }

  // Safe sort column validation
  let orderClause = '';
  if (sortColumn) {
    const schema = await getTableSchema(tableName);
    const validCols = schema.map((c: any) => c.column_name);
    if (validCols.includes(sortColumn)) {
      const dir = sortDir === 'desc' ? 'DESC' : 'ASC';
      orderClause = `ORDER BY "${sortColumn}" ${dir}`;
    }
  }

  let whereClause = '';
  const params: any[] = [];

  if (search) {
    const schema = await getTableSchema(tableName);
    const textCols = schema
      .filter((c: any) => ['TEXT', 'VARCHAR', 'CHAR', 'character varying', 'text'].includes((c.data_type || '').toUpperCase()))
      .map((c: any) => `CAST("${c.column_name}" AS TEXT) LIKE ?`);

    if (textCols.length > 0) {
      whereClause = `WHERE (${textCols.join(' OR ')})`;
      params.push(...textCols.map(() => `%${search}%`));
    }
  }

  const isPostgres = !!process.env.DATABASE_URL;
  if (isPostgres && params.length > 0) {
    // Replace ? with $1, $2 etc for postgres
    let i = 1;
    whereClause = whereClause.replace(/\?/g, () => `$${i++}`);
  }

  const countSql = `SELECT COUNT(*) as cnt FROM "${tableName}" ${whereClause}`;
  const dataSql = `SELECT * FROM "${tableName}" ${whereClause} ${orderClause} LIMIT ${pageSize} OFFSET ${offset}`;

  const countResult = await query(countSql, params);
  const dataResult = await query(dataSql, params);

  const total = Number(countResult.rows[0]?.cnt || 0);

  return {
    rows: dataResult.rows,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

// ── DB Health ─────────────────────────────────────────────────────────────────

export async function getDbHealth() {
  const pingStart = Date.now();
  let connected = false;
  let errorMsg = '';

  try {
    await query('SELECT 1');
    connected = true;
  } catch (e: any) {
    errorMsg = e.message;
  }

  const pingMs = Date.now() - pingStart;

  // Recent errors
  let recentErrors: any[] = [];
  try {
    const errResult = await query(
      `SELECT * FROM system_error_logs ORDER BY created_at DESC LIMIT 10`
    );
    recentErrors = errResult.rows;
  } catch (_) {}

  // API error rate (last 100 requests)
  let errorRate = 0;
  try {
    const total = await query(`SELECT COUNT(*) as cnt FROM api_request_logs`);
    const errors = await query(`SELECT COUNT(*) as cnt FROM api_request_logs WHERE status_code >= 400`);
    const t = Number(total.rows[0]?.cnt || 0);
    const e = Number(errors.rows[0]?.cnt || 0);
    errorRate = t > 0 ? Math.round((e / t) * 100) : 0;
  } catch (_) {}

  return {
    connected,
    pingMs,
    errorMsg,
    environment: process.env.NODE_ENV || 'development',
    recentErrors,
    errorRate,
  };
}

// ── Global Search ─────────────────────────────────────────────────────────────

export async function globalDbSearch(term: string) {
  const tables = ['leads', 'users', 'campaigns', 'conversations', 'opportunities'];
  const results: Array<{ table: string; id: string; label: string }> = [];

  for (const table of tables) {
    try {
      const r = await query(
        `SELECT * FROM "${table}" WHERE 
          CAST(id AS TEXT) LIKE ? OR 
          CAST(business_name AS TEXT) LIKE ? OR
          CAST(contact_name AS TEXT) LIKE ? OR
          CAST(email AS TEXT) LIKE ? OR
          CAST(phone AS TEXT) LIKE ? OR
          CAST(name AS TEXT) LIKE ?
          LIMIT 5`,
        Array(6).fill(`%${term}%`)
      );
      for (const row of r.rows) {
        results.push({
          table,
          id: row.id,
          label: row.business_name || row.name || row.contact_name || row.id,
        });
      }
    } catch (_) {}
  }

  return results;
}
