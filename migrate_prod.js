const Database = require('better-sqlite3');
const db = new Database('mivra.db');

const migrations = [
  'CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_prod_featured ON products(is_featured, featured_until)',
  'CREATE INDEX IF NOT EXISTS idx_user_pro ON users(is_pro, pro_until)',
  "CREATE TABLE IF NOT EXISTS webhook_nonces (nonce TEXT PRIMARY KEY, method TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  'CREATE INDEX IF NOT EXISTS idx_nonce_age ON webhook_nonces(created_at)',
  "CREATE TABLE IF NOT EXISTS refunds (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, admin_id INTEGER NOT NULL, reason TEXT NOT NULL, amount INTEGER NOT NULL, revoke_service INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT)",
  'CREATE INDEX IF NOT EXISTS idx_refund_tx ON refunds(transaction_id)',
  'CREATE INDEX IF NOT EXISTS idx_refund_admin ON refunds(admin_id, created_at DESC)',
];

for (const sql of migrations) {
  try {
    db.prepare(sql).run();
    console.log('OK:', sql.slice(0, 70));
  } catch(e) {
    console.log('SKIP:', e.message.slice(0, 70));
  }
}

db.close();
console.log('Migration complete.');
