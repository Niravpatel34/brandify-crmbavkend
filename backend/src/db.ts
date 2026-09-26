import pg from 'pg';
import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let isPostgres = false;
let pgPool: pg.Pool | null = null;
let sqliteDb: sqlite3.Database | null = null;

// Database Connection initialization
export async function initDb() {
  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl) {
    try {
      console.log('Attempting to connect to PostgreSQL...');
      pgPool = new pg.Pool({ connectionString: dbUrl });
      await pgPool.query('SELECT NOW()');
      isPostgres = true;
      console.log('Successfully connected to PostgreSQL database.');
    } catch (error) {
      console.warn('PostgreSQL connection failed. Falling back to local SQLite database.', error);
      pgPool = null;
    }
  } else {
    console.log('No DATABASE_URL configured. Using local SQLite database.');
  }

  if (!isPostgres) {
    const dbPath = path.resolve(__dirname, '../../outreach.db');
    console.log(`Initializing SQLite database at: ${dbPath}`);
    sqliteDb = new sqlite3.Database(dbPath);
  }

  await createTables();
  await seedDefaultAdmin();
}

// Unified Query interface
export async function query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
  if (isPostgres && pgPool) {
    const res = await pgPool.query(sql, params);
    return { rows: res.rows };
  } else if (sqliteDb) {
    const sqliteSql = sql.replace(/\$\d+/g, '?');
    
    const adaptedParams = params.map(val => {
      if (typeof val === 'boolean') {
        return val ? 1 : 0;
      }
      return val;
    });

    return new Promise((resolve, reject) => {
      sqliteDb!.all(sqliteSql, adaptedParams, (err, rows) => {
        if (err) {
          console.error('SQLite query error: ', err, 'SQL:', sqliteSql);
          reject(err);
        } else {
          const processedRows = rows.map((row: any) => {
            const newRow = { ...row };
            for (const key in newRow) {
              if (key.includes('opt_in') || key.includes('eligible') || key === 'is_read') {
                newRow[key] = !!newRow[key];
              }
            }
            return newRow;
          });
          resolve({ rows: processedRows });
        }
      });
    });
  } else {
    throw new Error('Database not initialized');
  }
}

async function createTables() {
  const schema = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      mobile_number TEXT UNIQUE,
      full_name TEXT,
      password_hash TEXT,
      role TEXT DEFAULT 'admin',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS otp_store (
      id TEXT PRIMARY KEY,
      mobile_number TEXT NOT NULL,
      otp_code TEXT NOT NULL,
      purpose TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0,
      is_verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      business_name TEXT NOT NULL,
      contact_name TEXT,
      business_type TEXT,
      website TEXT,
      phone TEXT,
      whatsapp_number TEXT UNIQUE,
      instagram_username TEXT UNIQUE,
      email TEXT,
      city TEXT,
      source TEXT,
      whatsapp_opt_in INTEGER DEFAULT 0,
      whatsapp_opt_in_source TEXT,
      whatsapp_opt_in_date TEXT,
      instagram_eligible INTEGER DEFAULT 0,
      campaign_id TEXT,
      crm_status TEXT DEFAULT 'NEW',
      lead_score INTEGER DEFAULT 0,
      lead_score_category TEXT DEFAULT 'COLD',
      last_contacted_at TEXT,
      next_followup_at TEXT,
      reply_status TEXT,
      sentiment TEXT,
      notes TEXT,
      is_client INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      channel TEXT,
      status TEXT DEFAULT 'DRAFT',
      template_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS message_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      meta_template_id TEXT,
      language TEXT DEFAULT 'en',
      category TEXT,
      body_text TEXT,
      status TEXT DEFAULT 'DRAFT',
      usage_count INTEGER DEFAULT 0,
      conversion_rate NUMERIC DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS outreach_queue (
      id TEXT PRIMARY KEY,
      campaign_id TEXT,
      lead_id TEXT,
      message_body TEXT,
      status TEXT DEFAULT 'WAITING',
      error_message TEXT,
      attempts INTEGER DEFAULT 0,
      scheduled_at TEXT DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS suppression_list (
      id TEXT PRIMARY KEY,
      phone TEXT,
      instagram_username TEXT,
      reason TEXT,
      source TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      action TEXT,
      details TEXT,
      performed_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS integrations (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      channel TEXT NOT NULL,
      message_text TEXT NOT NULL,
      status TEXT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS lead_notes (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      author TEXT DEFAULT 'admin',
      note_text TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS lead_followups (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      followup_date TEXT NOT NULL,
      followup_time TEXT,
      reason TEXT,
      priority TEXT DEFAULT 'MEDIUM',
      status TEXT DEFAULT 'PENDING',
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS lead_activity_logs (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      performed_by TEXT DEFAULT 'System',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS saved_views (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      user_id TEXT DEFAULT 'admin',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS webhook_logs (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      event_type TEXT,
      payload_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      title TEXT NOT NULL,
      estimated_value INTEGER DEFAULT 0,
      probability INTEGER DEFAULT 50,
      stage TEXT DEFAULT 'QUALIFIED',
      expected_close_date TEXT,
      owner TEXT DEFAULT 'admin',
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      opportunity_id TEXT,
      title TEXT NOT NULL,
      package_name TEXT,
      items_json TEXT NOT NULL,
      total_amount NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'DRAFT',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      title TEXT NOT NULL,
      meeting_date TEXT NOT NULL,
      meeting_time TEXT DEFAULT '10:00',
      location_url TEXT,
      status TEXT DEFAULT 'SCHEDULED',
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL UNIQUE,
      business_name TEXT NOT NULL,
      client_tier TEXT DEFAULT 'STANDARD',
      mrr INTEGER DEFAULT 0,
      converted_at TEXT DEFAULT CURRENT_TIMESTAMP,
      notes TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      link_path TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS system_error_logs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      error_code TEXT,
      message_text TEXT NOT NULL,
      recommended_action TEXT,
      lead_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      version TEXT NOT NULL,
      status TEXT DEFAULT 'APPLIED',
      executed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      rolled_back_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS api_request_logs (
      id TEXT PRIMARY KEY,
      method TEXT,
      path TEXT,
      status_code INTEGER,
      response_time_ms INTEGER,
      user_id TEXT,
      environment TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS db_backups (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'COMPLETED',
      created_by TEXT DEFAULT 'admin',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const tableSql of schema) {
    await query(tableSql);
  }

  try {
    await query(`ALTER TABLE leads RENAME COLUMN status TO crm_status`);
  } catch (e) {}

  const columnMigrations = [
    `ALTER TABLE users ADD COLUMN mobile_number TEXT`,
    `ALTER TABLE users ADD COLUMN full_name TEXT`,
    `ALTER TABLE leads ADD COLUMN area TEXT`,
    `ALTER TABLE leads ADD COLUMN state TEXT`,
    `ALTER TABLE leads ADD COLUMN subcategory TEXT`,
    `ALTER TABLE leads ADD COLUMN tags TEXT`,
    `ALTER TABLE leads ADD COLUMN assigned_user TEXT DEFAULT 'admin'`,
    `ALTER TABLE leads ADD COLUMN lead_score_category TEXT DEFAULT 'COLD'`,
    `ALTER TABLE leads ADD COLUMN is_client INTEGER DEFAULT 0`,
    `ALTER TABLE conversations ADD COLUMN wamid TEXT`
  ];

  for (const colSql of columnMigrations) {
    try {
      await query(colSql);
    } catch (e) {}
  }
}

async function seedDefaultAdmin() {
  const existing = await query('SELECT * FROM users WHERE username = $1 OR mobile_number = $2', ['admin', '+919876543210']);
  const defaultHash = bcrypt.hashSync('admin123', 10);

  if (existing.rows.length === 0) {
    await query(
      'INSERT INTO users (id, username, mobile_number, full_name, password_hash, role) VALUES ($1, $2, $3, $4, $5, $6)',
      [crypto.randomUUID(), 'admin', '+919876543210', 'Brandify Admin', defaultHash, 'super_admin']
    );
    console.log('Seeded default super_admin user (Mobile: +919876543210 / Username: admin / Password: admin123)');
  } else {
    // Ensure existing admin user has mobile number set and password hash synced to admin123
    const user = existing.rows[0];
    const matches = bcrypt.compareSync('admin123', user.password_hash);
    if (!matches) {
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [defaultHash, user.id]);
    }
    // Upgrade to super_admin if currently just 'admin'
    if (user.role === 'admin') {
      await query('UPDATE users SET role = $1 WHERE id = $2', ['super_admin', user.id]);
      console.log('[DB] Upgraded default admin to super_admin role');
    }
    await query(
      'UPDATE users SET mobile_number = $1, full_name = $2 WHERE (username = $3 OR mobile_number = $1)',
      ['+919876543210', 'Brandify Admin', 'admin']
    );
  }
}
