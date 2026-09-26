import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
// ── Ensure backup directory exists ───────────────────────────────────────────
function ensureBackupDir() {
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
}
// ── Create SQLite Backup ──────────────────────────────────────────────────────
export async function createBackup(createdBy = 'admin') {
    const isPostgres = !!process.env.DATABASE_URL;
    if (isPostgres) {
        throw new Error('Automated backup is available for SQLite only. Use pg_dump for PostgreSQL backups.');
    }
    ensureBackupDir();
    const dbPath = path.resolve(__dirname, '../../../outreach.db');
    if (!fs.existsSync(dbPath)) {
        throw new Error('SQLite database file not found at expected path.');
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `outreach_backup_${timestamp}.db`;
    const destPath = path.join(BACKUP_DIR, filename);
    fs.copyFileSync(dbPath, destPath);
    const stat = fs.statSync(destPath);
    const backupId = crypto.randomUUID();
    await query(`INSERT INTO db_backups (id, filename, size_bytes, status, created_by) VALUES ($1, $2, $3, $4, $5)`, [backupId, filename, stat.size, 'COMPLETED', createdBy]);
    return { id: backupId, filename, sizeBytes: stat.size, createdAt: new Date().toISOString() };
}
// ── List Backups ──────────────────────────────────────────────────────────────
export async function listBackups() {
    const result = await query(`SELECT * FROM db_backups ORDER BY created_at DESC LIMIT 50`);
    return result.rows;
}
// ── Get Backup File Path (for download) ──────────────────────────────────────
export function getBackupFilePath(filename) {
    ensureBackupDir();
    const filePath = path.join(BACKUP_DIR, filename);
    // Security: ensure the resolved path stays inside BACKUP_DIR
    if (!filePath.startsWith(BACKUP_DIR)) {
        throw new Error('Invalid backup filename');
    }
    if (!fs.existsSync(filePath)) {
        throw new Error('Backup file not found');
    }
    return filePath;
}
