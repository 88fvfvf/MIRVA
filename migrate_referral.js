const Database = require('better-sqlite3');
const db = new Database('mivra.db');

const migrations = [
  // Add referral columns to users
  "ALTER TABLE users ADD COLUMN referral_code TEXT",
  "ALTER TABLE users ADD COLUMN available_boosts INTEGER NOT NULL DEFAULT 0",
  // Unique index on referral_code
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref_code ON users(referral_code) WHERE referral_code IS NOT NULL",
  // referrals table
  "CREATE TABLE IF NOT EXISTS referrals (id TEXT PRIMARY KEY, inviter_id INTEGER NOT NULL, invited_id INTEGER NOT NULL UNIQUE, invited_role TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), activated_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_ref_inviter ON referrals(inviter_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_ref_invited ON referrals(invited_id)",
  // referral_rewards table
  "CREATE TABLE IF NOT EXISTS referral_rewards (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, milestone INTEGER NOT NULL, earned_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ref_reward_uniq ON referral_rewards(user_id, type)",
  "CREATE INDEX IF NOT EXISTS idx_ref_reward_user ON referral_rewards(user_id)",
];

for (const sql of migrations) {
  try {
    db.prepare(sql).run();
    console.log('OK:', sql.slice(0, 80));
  } catch(e) {
    if (e.message.includes('duplicate column') || e.message.includes('already exists')) {
      console.log('SKIP (already exists):', sql.slice(0, 60));
    } else {
      console.log('ERR:', e.message.slice(0, 80));
    }
  }
}

db.close();
console.log('Referral migration complete.');
