const Database = require('better-sqlite3');
const db = new Database('mivra.db');

try { db.prepare('ALTER TABLE users ADD COLUMN is_pro INTEGER NOT NULL DEFAULT 0').run(); } catch(e) {}
try { db.prepare('ALTER TABLE users ADD COLUMN pro_until TEXT').run(); } catch(e) {}

try { db.prepare('ALTER TABLE products ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0').run(); } catch(e) {}
try { db.prepare('ALTER TABLE products ADD COLUMN featured_until TEXT').run(); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id             TEXT PRIMARY KEY,
    mivra_tx_id    TEXT NOT NULL UNIQUE,
    user_id        INTEGER NOT NULL,
    product_id     TEXT,
    type           TEXT NOT NULL,
    amount         INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tx_status_date ON transactions(status, created_at DESC);
`);
console.log('Migrations applied');
