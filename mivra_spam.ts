/**
 * mivra_spam.ts — Anti-Spam & Rate Limiting for MIVRA v7 (Task 1)
 *
 * Surfaces protected:
 *  Store users
 *    • req_cooldown   — 60 s between request creates
 *    • req_duplicate  — identical request within 15 min (logic in RequestRepository)
 *    • req_daily      — max 10 requests per day
 *  Supplier users
 *    • offer_daily    — max offers/day (tier-dependent)
 *    • prod_daily     — max product adds/day (tier-dependent)
 *    • offer_dup      — same supplier can't offer twice on same request (logic in repo)
 *  Analytics
 *    • view_dedup     — 1 view per user per product per 24 h
 *    • contact_dedup  — 1 contact per user per product per 1 h
 *  Admin
 *    • broadcast      — max 3 broadcasts per hour per admin
 *  General
 *    • rateLimit()    — 1.5 s global action cooldown (replaces original rateLimit())
 *
 * Storage: rate_limits table (SQLite) + in-memory LRU for hot view/contact paths.
 * Cleanup: call spam.cleanup() periodically (e.g. hourly) to prune old DB entries.
 */

import Database from 'better-sqlite3';
import type { SupplierTier } from './mivra_repos';

// ── Tier-based daily limits ───────────────────────────────────────────────────

export const DAILY_OFFER_LIMITS: Record<SupplierTier, number> = {
    free: 20, premium: 50, enterprise: 999,
};
export const DAILY_PROD_LIMITS: Record<SupplierTier, number> = {
    free: 5, premium: 20, enterprise: 999,
};

// ── Windows (ms) ──────────────────────────────────────────────────────────────

const REQ_COOLDOWN_MS = 60_000;       // 1 min between request creates
const VIEW_WINDOW_MS = 86_400_000;   // 24 h view dedup
const CONTACT_WINDOW_MS = 3_600_000;    // 1 h contact dedup
const BROADCAST_WINDOW = 3_600_000;    // 1 h broadcast window
const MAX_BROADCASTS_PER_HOUR = 3;

// ── SpamGuard ─────────────────────────────────────────────────────────────────

export class SpamGuard {
    /** In-memory cache for the view/contact hot-path (avoids a DB read per catalog scroll) */
    private memCache = new Map<string, number>(); // key → last timestamp (ms)
    private readonly CACHE_MAX = 20_000;

    /** Per-user global action cooldown */
    private actionTs = new Map<number, number>();

    constructor(private db: Database.Database) { }

    // ── General action throttle (drop-in for original rateLimit()) ────────────

    rateLimit(uid: number, ms = 1500): boolean {
        const now = Date.now();
        const last = this.actionTs.get(uid) ?? 0;
        if (now - last < ms) return false;
        this.actionTs.set(uid, now);
        return true;
    }

    // ── Request creation cooldown (60 s) ─────────────────────────────────────

    checkRequestCooldown(userId: number): { ok: boolean; waitSecs?: number } {
        const key = `rq_cd:${userId}`;
        const now = Date.now();

        // Fast in-memory check
        const cached = this.memCache.get(key);
        if (cached && now - cached < REQ_COOLDOWN_MS) {
            return { ok: false, waitSecs: Math.ceil((REQ_COOLDOWN_MS - (now - cached)) / 1000) };
        }

        // DB check
        const row = this.db.prepare('SELECT last_at FROM rate_limits WHERE key=?').get(key) as any;
        if (row) {
            const diff = now - new Date(row.last_at).getTime();
            if (diff < REQ_COOLDOWN_MS) {
                this.memCache.set(key, now - diff); // sync cache
                return { ok: false, waitSecs: Math.ceil((REQ_COOLDOWN_MS - diff) / 1000) };
            }
        }

        this.touch(key, now);
        return { ok: true };
    }

    // ── Offer daily limit ─────────────────────────────────────────────────────

    checkOfferDaily(supplierId: number, tier: SupplierTier): { ok: boolean; used?: number; limit?: number } {
        const limit = DAILY_OFFER_LIMITS[tier] ?? 20;
        const key = `of_d:${supplierId}`;
        const today = todayStr();

        const row = this.db.prepare('SELECT count, window_start FROM rate_limits WHERE key=?').get(key) as any;
        if (row) {
            if (row.window_start.slice(0, 10) === today) {
                if (Number(row.count) >= limit) return { ok: false, used: Number(row.count), limit };
            } else {
                this.db.prepare('DELETE FROM rate_limits WHERE key=?').run(key);
            }
        }

        this.incrementDay(key);
        return { ok: true };
    }

    // ── Product add daily limit ───────────────────────────────────────────────

    checkProductDaily(supplierId: number, tier: SupplierTier): { ok: boolean; used?: number; limit?: number } {
        const limit = DAILY_PROD_LIMITS[tier] ?? 5;
        const key = `pd_d:${supplierId}`;
        const today = todayStr();

        const row = this.db.prepare('SELECT count, window_start FROM rate_limits WHERE key=?').get(key) as any;
        if (row) {
            if (row.window_start.slice(0, 10) === today) {
                if (Number(row.count) >= limit) return { ok: false, used: Number(row.count), limit };
            } else {
                this.db.prepare('DELETE FROM rate_limits WHERE key=?').run(key);
            }
        }

        this.incrementDay(key);
        return { ok: true };
    }

    // ── Product view dedup (24 h per user per product) ────────────────────────

    /**
     * Returns true  = new unique view  → increment product.view_count
     * Returns false = duplicate        → skip
     */
    trackView(userId: number, productId: string): boolean {
        if (!userId) return true; // anonymous always counts

        const key = `vw:${userId}:${productId}`;
        const now = Date.now();

        const cached = this.memCache.get(key);
        if (cached && now - cached < VIEW_WINDOW_MS) return false;

        const row = this.db.prepare('SELECT last_at FROM rate_limits WHERE key=?').get(key) as any;
        if (row) {
            const diff = now - new Date(row.last_at).getTime();
            if (diff < VIEW_WINDOW_MS) {
                this.memCache.set(key, now - diff);
                return false;
            }
        }

        this.touch(key, now);
        this.cacheSet(key, now);
        return true;
    }

    // ── Contact click dedup (1 h per user per product) ────────────────────────

    /**
     * Returns true  = new contact click  → increment product.contact_clicks
     * Returns false = duplicate           → skip
     */
    trackContact(userId: number, productId: string): boolean {
        const key = `ct:${userId}:${productId}`;
        const now = Date.now();

        const cached = this.memCache.get(key);
        if (cached && now - cached < CONTACT_WINDOW_MS) return false;

        const row = this.db.prepare('SELECT last_at FROM rate_limits WHERE key=?').get(key) as any;
        if (row) {
            const diff = now - new Date(row.last_at).getTime();
            if (diff < CONTACT_WINDOW_MS) {
                this.memCache.set(key, now - diff);
                return false;
            }
        }

        this.touch(key, now);
        this.cacheSet(key, now);
        return true;
    }

    // ── Broadcast rate limit ──────────────────────────────────────────────────

    checkBroadcast(adminId: number): { ok: boolean; used?: number; nextIn?: string } {
        const key = `bc:${adminId}`;
        const now = Date.now();

        const row = this.db.prepare('SELECT count, window_start FROM rate_limits WHERE key=?').get(key) as any;
        if (row) {
            const windowAge = now - new Date(row.window_start).getTime();
            if (windowAge < BROADCAST_WINDOW) {
                if (Number(row.count) >= MAX_BROADCASTS_PER_HOUR) {
                    const remainMs = BROADCAST_WINDOW - windowAge;
                    const mins = Math.ceil(remainMs / 60_000);
                    return { ok: false, used: Number(row.count), nextIn: `${mins} мин` };
                }
            } else {
                this.db.prepare('DELETE FROM rate_limits WHERE key=?').run(key);
            }
        }

        this.touch(key, now);
        return { ok: true };
    }

    /** Record a completed broadcast in history */
    logBroadcast(adminId: number, message: string, targetRole: string | null, sentCount: number): void {
        this.db.prepare(`
      INSERT INTO broadcast_history (admin_id, message, target_role, sent_count, sent_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(adminId, message.slice(0, 2000), targetRole, sentCount);
    }

    /** Purge rate_limit entries older than 7 days and trim in-memory cache */
    cleanup(): void {
        const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
        this.db.prepare('DELETE FROM rate_limits WHERE last_at < ?').run(cutoff);

        if (this.memCache.size > this.CACHE_MAX) {
            // Evict oldest half
            const sorted = [...this.memCache.entries()].sort((a, b) => a[1] - b[1]);
            for (const [k] of sorted.slice(0, this.CACHE_MAX / 2)) this.memCache.delete(k);
        }
    }

    /** Start a periodic cleanup timer (call once at startup) */
    startCleanupTimer(intervalMs = 3_600_000): NodeJS.Timeout {
        return setInterval(() => this.cleanup(), intervalMs);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    private touch(key: string, nowMs: number): void {
        const ts = new Date(nowMs).toISOString();
        this.db.prepare(`
      INSERT INTO rate_limits (key, count, window_start, last_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(key) DO UPDATE SET count=count+1, last_at=excluded.last_at
    `).run(key, ts, ts);
    }

    private incrementDay(key: string): void {
        const ts = new Date().toISOString();
        this.db.prepare(`
      INSERT INTO rate_limits (key, count, window_start, last_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(key) DO UPDATE SET count=count+1, last_at=excluded.last_at
    `).run(key, ts, ts);
    }

    private cacheSet(key: string, ts: number): void {
        this.memCache.set(key, ts);
    }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function todayStr(): string {
    return new Date().toISOString().slice(0, 10);
}