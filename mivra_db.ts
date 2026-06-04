/**
 * mivra_db.ts — SQLite Database Layer for MIVRA v7
 *
 * Replaces JSON file storage with proper SQLite.
 * Uses better-sqlite3 (synchronous) — no async/await needed for DB calls.
 *
 * Schema decisions:
 *  • users       — single table with nullable role-specific columns
 *                  (simpler joins than separate store_users/supplier_users)
 *  • products     — separate from users for efficient catalog queries
 *  • products_fts — FTS5 virtual table for smart full-text search (Task 2)
 *  • requests     — request metadata only; offers are in a child table
 *  • offers       — child table so we can UPDATE individual offers efficiently
 *  • favorites    — many-to-many (user × product)
 *  • deals        — append-only completion records
 *  • analytics_events — time-series for product analytics
 *  • rate_limits  — anti-spam counters (Task 1)
 *  • broadcast_history — tracks admin broadcasts to prevent abuse
 *
 * WAL journal mode: readers never block writers, survives process crashes.
 */

import Database from 'better-sqlite3';
import * as path from 'path';

// ── Connection singleton ──────────────────────────────────────────────────────

let _instance: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (!_instance) {
    const p = dbPath ?? path.join(process.cwd(), 'mivra.db');
    _instance = new Database(p);

    // WAL mode: concurrent reads + crash-safe writes
    _instance.pragma('journal_mode = WAL');
    // Enforce FK constraints (SQLite disables them by default)
    _instance.pragma('foreign_keys = ON');
    // NORMAL sync is safe in WAL mode and much faster than FULL
    _instance.pragma('synchronous = NORMAL');
    // 32 MB page cache — keeps hot data in memory
    _instance.pragma('cache_size = -32000');
    // Temp tables in RAM
    _instance.pragma('temp_store = MEMORY');
    // Wait up to 5 s if another writer holds the lock
    _instance.pragma('busy_timeout = 5000');

    initSchema(_instance);
  }
  return _instance;
}

export function closeDb(): void {
  if (_instance) { _instance.close(); _instance = null; }
}

// ── Schema ────────────────────────────────────────────────────────────────────

export function initSchema(db: Database.Database): void {
  db.exec(`

  -- ── USERS ─────────────────────────────────────────────────────────────────
  -- Single table for all role types. Role-specific columns are nullable.
  -- Storing categories as JSON array avoids a join for the common "does this
  -- supplier cover this category?" check.
  CREATE TABLE IF NOT EXISTS users (
    id                   INTEGER PRIMARY KEY,   -- Telegram user ID
    role                 TEXT    NOT NULL DEFAULT 'user',
    first_name           TEXT    NOT NULL DEFAULT '',
    username             TEXT,
    lang                 TEXT    NOT NULL DEFAULT 'ru',
    registered_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    -- store
    store_name           TEXT,
    phone                TEXT,
    city                 TEXT,
    -- supplier
    company_name         TEXT,
    contact_person       TEXT,
    business_description TEXT,
    approved             INTEGER NOT NULL DEFAULT 0,
    suspended            INTEGER NOT NULL DEFAULT 0,
    tier                 TEXT    NOT NULL DEFAULT 'free',
    categories           TEXT    NOT NULL DEFAULT '[]',   -- JSON: string[]
    is_pro               INTEGER NOT NULL DEFAULT 0,
    pro_until            TEXT
  );

  -- Catalog: filter active suppliers quickly
  CREATE INDEX IF NOT EXISTS idx_users_sup_active
    ON users(role, approved, suspended) WHERE role = 'supplier';

  -- ── PRODUCTS ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS products (
    id                  TEXT    PRIMARY KEY,
    supplier_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    supplier_name       TEXT    NOT NULL DEFAULT '',
    supplier_phone      TEXT    NOT NULL DEFAULT '',
    supplier_username   TEXT,
    name                TEXT    NOT NULL DEFAULT '',
    category            TEXT    NOT NULL DEFAULT '',
    description         TEXT    NOT NULL DEFAULT '',
    weight_volume       TEXT    NOT NULL DEFAULT '',
    units_per_box       TEXT    NOT NULL DEFAULT '',
    min_order_qty       TEXT    NOT NULL DEFAULT '',
    price               TEXT    NOT NULL DEFAULT '',
    price_negotiable    INTEGER NOT NULL DEFAULT 0,
    delivery_available  INTEGER NOT NULL DEFAULT 0,
    city                TEXT    NOT NULL DEFAULT '',
    availability_status TEXT    NOT NULL DEFAULT '',
    photos              TEXT    NOT NULL DEFAULT '[]',  -- JSON: string[]
    view_count          INTEGER NOT NULL DEFAULT 0,
    contact_clicks      INTEGER NOT NULL DEFAULT 0,
    offer_responses     INTEGER NOT NULL DEFAULT 0,
    completed_deals     INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    archived            INTEGER NOT NULL DEFAULT 0,
    delivery_scope      TEXT    NOT NULL DEFAULT 'regional',
    is_featured         INTEGER NOT NULL DEFAULT 0,
    featured_until      TEXT
  );

  -- Supplier's own product list (my products page, tier limit check)
  CREATE INDEX IF NOT EXISTS idx_products_supplier
    ON products(supplier_id, archived);
  -- Active catalog browse
  CREATE INDEX IF NOT EXISTS idx_products_catalog
    ON products(archived, created_at DESC);
  -- Category & city filters
  CREATE INDEX IF NOT EXISTS idx_products_cat   ON products(category, archived);
  CREATE INDEX IF NOT EXISTS idx_products_city  ON products(city, archived);
  -- Analytics ranking
  CREATE INDEX IF NOT EXISTS idx_products_views
    ON products(view_count DESC) WHERE archived = 0;

  -- ── PRODUCTS FTS5 (Smart Search — Task 2) ─────────────────────────────────
  -- Concatenates name + category + description + supplier_name into one
  -- searchable document. unicode61 tokenizer handles Cyrillic and Latin.
  -- "remove_diacritics 2" normalises accented chars across both scripts.
  CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
    product_id   UNINDEXED,
    search_text,
    tokenize     = 'unicode61 remove_diacritics 2'
  );

  -- ── REQUESTS ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS requests (
    id                TEXT    PRIMARY KEY,
    store_id          INTEGER NOT NULL REFERENCES users(id),
    store_name        TEXT    NOT NULL DEFAULT '',
    store_phone       TEXT    NOT NULL DEFAULT '',
    store_username    TEXT,
    product           TEXT    NOT NULL DEFAULT '',
    category          TEXT    NOT NULL DEFAULT '',
    specification     TEXT    NOT NULL DEFAULT '',
    quantity          TEXT    NOT NULL DEFAULT '',
    unit_type         TEXT    NOT NULL DEFAULT '',
    city              TEXT    NOT NULL DEFAULT '',
    delivery_address  TEXT    NOT NULL DEFAULT '',
    required_date     TEXT    NOT NULL DEFAULT '',
    additional_notes  TEXT    NOT NULL DEFAULT '',
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    status            TEXT    NOT NULL DEFAULT 'active',
    accepted_offer_id TEXT,
    status_history    TEXT    NOT NULL DEFAULT '[]'  -- JSON: StatusHistoryEntry[]
  );

  -- Store's requests by status
  CREATE INDEX IF NOT EXISTS idx_requests_store
    ON requests(store_id, status);
  -- Open requests list for suppliers
  CREATE INDEX IF NOT EXISTS idx_requests_open
    ON requests(status, created_at DESC);
  -- Dup-request check (product + store + created_at)
  CREATE INDEX IF NOT EXISTS idx_requests_dup
    ON requests(store_id, product, created_at DESC);

  -- ── OFFERS ───────────────────────────────────────────────────────────────
  -- Child table so individual offers can be updated without rewriting the
  -- entire request row (important for M3 offer improvement).
  CREATE TABLE IF NOT EXISTS offers (
    id                 TEXT    PRIMARY KEY,
    request_id         TEXT    NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    supplier_id        INTEGER NOT NULL REFERENCES users(id),
    supplier_name      TEXT    NOT NULL DEFAULT '',
    supplier_phone     TEXT    NOT NULL DEFAULT '',
    supplier_username  TEXT,
    price              TEXT    NOT NULL DEFAULT '',
    delivery_available INTEGER NOT NULL DEFAULT 0,
    price_negotiable   INTEGER NOT NULL DEFAULT 0,
    estimated_delivery TEXT    NOT NULL DEFAULT '',
    comment            TEXT    NOT NULL DEFAULT '',
    status             TEXT    NOT NULL DEFAULT 'pending',
    created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Offer board for a given request
  CREATE INDEX IF NOT EXISTS idx_offers_request
    ON offers(request_id, status, created_at);
  -- Supplier's own offers (dup check, market position, M3 update)
  CREATE INDEX IF NOT EXISTS idx_offers_supplier
    ON offers(supplier_id, request_id);

  -- ── FAVORITES ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS favorites (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id TEXT    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, product_id)
  );
  CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id);

  -- ── DEALS ────────────────────────────────────────────────────────────────
  -- Append-only. Completed deals never change.
  CREATE TABLE IF NOT EXISTS deals (
    id            TEXT    PRIMARY KEY,
    request_id    TEXT    NOT NULL,
    store_name    TEXT    NOT NULL DEFAULT '',
    store_id      INTEGER NOT NULL,
    supplier_name TEXT    NOT NULL DEFAULT '',
    supplier_id   INTEGER NOT NULL,
    product       TEXT    NOT NULL DEFAULT '',
    quantity      TEXT    NOT NULL DEFAULT '',
    unit_type     TEXT    NOT NULL DEFAULT '',
    price         TEXT    NOT NULL DEFAULT '',
    completed_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    product_id    TEXT
  );

  -- Supplier deal count (rankings, dashboard)
  CREATE INDEX IF NOT EXISTS idx_deals_supplier
    ON deals(supplier_id, completed_at DESC);
  -- Store purchase history
  CREATE INDEX IF NOT EXISTS idx_deals_store ON deals(store_id);
  -- Time-based analytics (weekly/monthly)
  CREATE INDEX IF NOT EXISTS idx_deals_time ON deals(completed_at DESC);

  -- ── ANALYTICS EVENTS ─────────────────────────────────────────────────────
  -- Time-series for per-product stats (views, contacts, offers, deals).
  -- Separate from deals table so we can track partial funnel steps.
  CREATE TABLE IF NOT EXISTS analytics_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT    NOT NULL,       -- 'view'|'contact'|'offer'|'deal'
    product_id  TEXT    NOT NULL,
    supplier_id INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    at          TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Per-product funnel stats
  CREATE INDEX IF NOT EXISTS idx_ae_product
    ON analytics_events(product_id, type);
  -- 24h dedup check for views
  CREATE INDEX IF NOT EXISTS idx_ae_dedup
    ON analytics_events(user_id, product_id, type, at);

  -- ── RATE LIMITS (Anti-spam — Task 1) ──────────────────────────────────────
  -- Stores rolling counters for all spam-prevention rules.
  -- key naming convention:
  --   req_cooldown:<userId>        — 60s between request creates
  --   req_daily:<userId>           — max 10 requests/day
  --   offer_daily:<supplierId>     — max offers/day per tier
  --   prod_daily:<supplierId>      — max product adds/day per tier
  --   broadcast:<adminId>          — max 3 broadcasts/hour
  --   view:<userId>:<productId>    — 24h view dedup
  --   contact:<userId>:<productId> — 1h contact dedup
  CREATE TABLE IF NOT EXISTS rate_limits (
    key          TEXT    PRIMARY KEY,
    count        INTEGER NOT NULL DEFAULT 1,
    window_start TEXT    NOT NULL DEFAULT (datetime('now')),
    last_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  -- Cleanup index (periodically purge old entries)
  CREATE INDEX IF NOT EXISTS idx_rl_window ON rate_limits(window_start);

  -- ── BROADCAST HISTORY ────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS broadcast_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id    INTEGER NOT NULL,
    message     TEXT    NOT NULL,
    target_role TEXT,                  -- NULL=all, 'store', 'supplier'
    sent_count  INTEGER NOT NULL DEFAULT 0,
    sent_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bc_admin
    ON broadcast_history(admin_id, sent_at DESC);

  -- ── MIGRATION TRACKING ───────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS _meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- ── TRANSACTIONS (Paycom) ────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS transactions (
    id             TEXT PRIMARY KEY,
    mivra_tx_id    TEXT NOT NULL UNIQUE,
    user_id        INTEGER NOT NULL,
    product_id     TEXT,
    type           TEXT NOT NULL,
    amount         INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    perform_time   TEXT,
    cancel_time    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tx_status_date ON transactions(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);

  -- ── WEBHOOK NONCES (replay deduplication) ────────────────────────────────
  -- Stores a hash of each processed webhook payload.
  -- Duplicate payload hashes are rejected even if the timestamp is fresh.
  CREATE TABLE IF NOT EXISTS webhook_nonces (
    nonce      TEXT PRIMARY KEY,           -- SHA-256 of (method+paycomId+amount+time)
    method     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Auto-purge nonces older than 1 hour (window > replay window) via cleanup job
  CREATE INDEX IF NOT EXISTS idx_nonce_age ON webhook_nonces(created_at);

  -- ── REFUNDS (admin-controlled) ────────────────────────────────────────────
  -- Separate from Paycom CancelTransaction.
  -- Only admins can insert refund records.
  -- A refund may revoke PRO/FEATURED early (unlike accounting-only cancellation).
  CREATE TABLE IF NOT EXISTS refunds (
    id             TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL REFERENCES transactions(id),
    admin_id       INTEGER NOT NULL,
    reason         TEXT NOT NULL,
    amount         INTEGER NOT NULL,
    revoke_service INTEGER NOT NULL DEFAULT 1, -- 1 = revoke PRO/Featured, 0 = money-only
    status         TEXT NOT NULL DEFAULT 'pending', -- pending | completed | rejected
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_refund_tx ON refunds(transaction_id);
  CREATE INDEX IF NOT EXISTS idx_refund_admin ON refunds(admin_id, created_at DESC);

  -- ── Additional indexes for monetization expiry queries ────────────────────
  CREATE INDEX IF NOT EXISTS idx_prod_featured ON products(is_featured, featured_until);
  CREATE INDEX IF NOT EXISTS idx_user_pro ON users(is_pro, pro_until);

  -- ── SESSIONS (persist multi-step flows across restarts) ────────────────────
  CREATE TABLE IF NOT EXISTS sessions (
    user_id    INTEGER PRIMARY KEY,
    step       TEXT,
    temp_data  TEXT    NOT NULL DEFAULT '{}',
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  `);
}

