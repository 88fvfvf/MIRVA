#!/usr/bin/env node
/**
 * backup.js — MIVRA Daily Backup Script
 *
 * Backs up the transactions, refunds, and users tables to a timestamped JSON file.
 * Run via cron or npm script: node backup.js
 *
 * Tables backed up (immutable financial records):
 *   - transactions  (all Paycom payment records)
 *   - refunds       (all admin refund records)
 *   - users         (for cross-referencing userId → name in investigations)
 *
 * Products and analytics are not backed up here (recoverable from suppliers).
 *
 * Output: ./backups/mivra_backup_YYYY-MM-DD_HH-MM.json
 */

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');
require('dotenv').config();

const DB_PATH    = process.env.DB_PATH    || './mivra.db';
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[BACKUP] Database not found: ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 16); // YYYY-MM-DDTHH-MM
  const filename = `mivra_backup_${stamp}.json`;
  const outPath  = path.join(BACKUP_DIR, filename);

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  console.log(`[BACKUP] Starting backup → ${outPath}`);

  const backup = {
    generated_at: now.toISOString(),
    db_path: DB_PATH,
    tables: {
      transactions: [],
      refunds:      [],
      users:        [],
    },
  };

  try {
    backup.tables.transactions = db.prepare('SELECT * FROM transactions ORDER BY created_at ASC').all();
    console.log(`[BACKUP] transactions: ${backup.tables.transactions.length} rows`);
  } catch (e) {
    console.error('[BACKUP] Failed to read transactions:', e.message);
  }

  try {
    backup.tables.refunds = db.prepare('SELECT * FROM refunds ORDER BY created_at ASC').all();
    console.log(`[BACKUP] refunds: ${backup.tables.refunds.length} rows`);
  } catch (e) {
    console.warn('[BACKUP] refunds table not found (may not exist yet):', e.message);
  }

  try {
    // Only backup non-sensitive user fields (no session data)
    backup.tables.users = db.prepare(
      'SELECT id, role, first_name, username, city, is_pro, pro_until, registered_at FROM users ORDER BY registered_at ASC'
    ).all();
    console.log(`[BACKUP] users: ${backup.tables.users.length} rows`);
  } catch (e) {
    console.error('[BACKUP] Failed to read users:', e.message);
  }

  db.close();

  fs.writeFileSync(outPath, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`[BACKUP] ✅ Backup complete: ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);

  // Prune backups older than 30 days
  pruneOldBackups(BACKUP_DIR, 30);
}

function pruneOldBackups(dir, maxDays) {
  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(dir).filter(f => f.startsWith('mivra_backup_') && f.endsWith('.json'));
  let pruned = 0;
  for (const f of files) {
    const fPath = path.join(dir, f);
    const stat  = fs.statSync(fPath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(fPath);
      pruned++;
    }
  }
  if (pruned > 0) console.log(`[BACKUP] Pruned ${pruned} backup(s) older than ${maxDays} days`);
}

main();
