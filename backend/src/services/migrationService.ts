import { query } from '../db.js';

// ── Built-in CRM migrations ───────────────────────────────────────────────────
// These are tracked in schema_migrations table.
// New schema changes should be added here as new entries.

interface Migration {
  name: string;
  version: string;
  sql: string[];
}

const MIGRATIONS: Migration[] = [
  {
    name: 'initial_schema',
    version: '1.0.0',
    sql: [], // Already applied via createTables() in db.ts — tracked retroactively
  },
  {
    name: 'add_lead_score_columns',
    version: '1.1.0',
    sql: [
      `ALTER TABLE leads ADD COLUMN lead_score INTEGER DEFAULT 0`,
      `ALTER TABLE leads ADD COLUMN lead_score_category TEXT DEFAULT 'COLD'`,
    ],
  },
  {
    name: 'add_wamid_to_conversations',
    version: '1.2.0',
    sql: [`ALTER TABLE conversations ADD COLUMN wamid TEXT`],
  },
  {
    name: 'add_schema_migrations_table',
    version: '1.3.0',
    sql: [], // Already created in db.ts createTables()
  },
  {
    name: 'add_api_request_logs_table',
    version: '1.4.0',
    sql: [], // Already created in db.ts createTables()
  },
  {
    name: 'add_db_backups_table',
    version: '1.5.0',
    sql: [], // Already created in db.ts createTables()
  },
];

// ── Sync migrations to DB ─────────────────────────────────────────────────────

export async function syncMigrations() {
  for (const migration of MIGRATIONS) {
    const existing = await query(
      `SELECT id FROM schema_migrations WHERE name = $1`,
      [migration.name]
    );
    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO schema_migrations (id, name, version, status) VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), migration.name, migration.version, 'APPLIED']
      );
    }
  }
}

// ── List migration status ─────────────────────────────────────────────────────

export async function getMigrations() {
  await syncMigrations();
  const result = await query(
    `SELECT * FROM schema_migrations ORDER BY executed_at ASC`
  );
  return result.rows;
}

// ── Run pending migrations ────────────────────────────────────────────────────

export async function runPendingMigrations(runByUser: string) {
  const pending = await query(
    `SELECT * FROM schema_migrations WHERE status = 'PENDING' ORDER BY version ASC`
  );

  const results: Array<{ name: string; status: string; error?: string }> = [];

  for (const row of pending.rows) {
    const migration = MIGRATIONS.find(m => m.name === row.name);
    if (!migration) {
      results.push({ name: row.name, status: 'SKIPPED' });
      continue;
    }

    let success = true;
    let errorMsg = '';

    for (const sql of migration.sql) {
      try {
        await query(sql);
      } catch (e: any) {
        // Ignore "already exists" type errors
        if (!e.message?.includes('duplicate column') && !e.message?.includes('already exists')) {
          success = false;
          errorMsg = e.message;
          break;
        }
      }
    }

    const status = success ? 'APPLIED' : 'FAILED';
    await query(
      `UPDATE schema_migrations SET status = $1, executed_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [status, row.id]
    );

    // Audit log
    await query(
      `INSERT INTO audit_logs (id, action, details, performed_by) VALUES ($1, $2, $3, $4)`,
      [
        crypto.randomUUID(),
        'MIGRATION_RUN',
        `Migration "${row.name}" (v${row.version}) — ${status}${errorMsg ? ': ' + errorMsg : ''}`,
        runByUser,
      ]
    );

    results.push({ name: row.name, status, error: errorMsg || undefined });
  }

  return results;
}
