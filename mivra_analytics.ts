/**
 * mivra_analytics.ts — Admin Analytics for MIVRA v7 (Task 3)
 *
 * buildAdminAnalytics()  — runs all queries, returns typed AdminStats object
 * formatAdminStats()     — renders AdminStats to Telegram Markdown
 *
 * All queries are single-pass aggregates over indexed columns.
 * Designed to run in < 5 ms on datasets up to 50k rows.
 */

import Database from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AdminStats {
    users: {
        totalStores: number;
        totalSuppliers: number;
        approvedSuppliers: number;
        pendingSuppliers: number;
    };
    products: {
        active: number;
        archived: number;
        totalViews: number;
    };
    requests: {
        open: number;
        completed: number;
        cancelled: number;
        totalOffers: number;
    };
    deals: {
        total: number;
        thisWeek: number;
        thisMonth: number;
    };
    topCategories: Array<{ category: string; count: number }>;
    topSuppliers: Array<{ supplierId: number; supplierName: string; deals: number }>;
    mostViewedProducts: Array<{ id: string; name: string; views: number }>;
    generatedAt: string;
}

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildAdminAnalytics(db: Database.Database): AdminStats {

    // ── Users (one pass) ─────────────────────────────────────────────────────
    const uRow = db.prepare(`
    SELECT
      SUM(CASE WHEN role = 'store'                              THEN 1 ELSE 0 END) AS stores,
      SUM(CASE WHEN role = 'supplier'                           THEN 1 ELSE 0 END) AS sups,
      SUM(CASE WHEN role = 'supplier' AND approved = 1          THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN role = 'supplier' AND approved = 0
               AND suspended = 0                               THEN 1 ELSE 0 END) AS pending
    FROM users
  `).get() as any;

    // ── Products (one pass) ──────────────────────────────────────────────────
    const pRow = db.prepare(`
    SELECT
      SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived,
      COALESCE(SUM(view_count), 0)                  AS total_views
    FROM products
  `).get() as any;

    // ── Requests + offer count (two queries, both indexed) ───────────────────
    const rRow = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('active','offer_received') THEN 1 ELSE 0 END) AS open_r,
      SUM(CASE WHEN status = 'completed'                  THEN 1 ELSE 0 END) AS completed_r,
      SUM(CASE WHEN status = 'cancelled'                  THEN 1 ELSE 0 END) AS cancelled_r
    FROM requests
  `).get() as any;
    const totalOffers = (db.prepare('SELECT COUNT(*) AS c FROM offers').get() as any)?.c ?? 0;

    // ── Deals (one pass with date windows) ──────────────────────────────────
    const dRow = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN completed_at >= datetime('now', '-7 days')  THEN 1 ELSE 0 END) AS this_week,
      SUM(CASE WHEN completed_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS this_month
    FROM deals
  `).get() as any;

    // ── Top categories (active products only) ────────────────────────────────
    const topCats = db.prepare(`
    SELECT category, COUNT(*) AS count
    FROM products WHERE archived = 0 AND category != ''
    GROUP BY category ORDER BY count DESC LIMIT 7
  `).all() as any[];

    // ── Top suppliers by completed deals ─────────────────────────────────────
    const topSups = db.prepare(`
    SELECT supplier_id, supplier_name, COUNT(*) AS deal_count
    FROM deals
    GROUP BY supplier_id ORDER BY deal_count DESC LIMIT 5
  `).all() as any[];

    // ── Most viewed products ─────────────────────────────────────────────────
    const topProds = db.prepare(`
    SELECT id, name, view_count FROM products
    WHERE archived = 0 AND view_count > 0
    ORDER BY view_count DESC LIMIT 5
  `).all() as any[];

    return {
        users: {
            totalStores: Number(uRow?.stores ?? 0),
            totalSuppliers: Number(uRow?.sups ?? 0),
            approvedSuppliers: Number(uRow?.approved ?? 0),
            pendingSuppliers: Number(uRow?.pending ?? 0),
        },
        products: {
            active: Number(pRow?.active ?? 0),
            archived: Number(pRow?.archived ?? 0),
            totalViews: Number(pRow?.total_views ?? 0),
        },
        requests: {
            open: Number(rRow?.open_r ?? 0),
            completed: Number(rRow?.completed_r ?? 0),
            cancelled: Number(rRow?.cancelled_r ?? 0),
            totalOffers: Number(totalOffers),
        },
        deals: {
            total: Number(dRow?.total ?? 0),
            thisWeek: Number(dRow?.this_week ?? 0),
            thisMonth: Number(dRow?.this_month ?? 0),
        },
        topCategories: topCats.map(r => ({ category: r.category, count: Number(r.count) })),
        topSuppliers: topSups.map(r => ({ supplierId: Number(r.supplier_id), supplierName: r.supplier_name, deals: Number(r.deal_count) })),
        mostViewedProducts: topProds.map(r => ({ id: r.id, name: r.name, views: Number(r.view_count) })),
        generatedAt: new Date().toISOString(),
    };
}

// ── Formatter ─────────────────────────────────────────────────────────────────

/** Renders AdminStats to Telegram-safe Markdown (MarkdownV2-compatible escaping) */
export function formatAdminStats(s: AdminStats): string {
    const e = (v: string | number) => String(v).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const n = (v: number) => e(v.toLocaleString('ru'));
    const bar = (count: number, max: number, len = 8) => {
        const filled = max > 0 ? Math.round((count / max) * len) : 0;
        return '█'.repeat(filled) + '░'.repeat(len - filled);
    };

    let t = `📊 *Статистика MIVRA*\n_${e(new Date(s.generatedAt).toLocaleString('ru'))}_\n\n`;

    // Users
    t += `*👥 Пользователи*\n`;
    t += `🏪 Магазинов: *${n(s.users.totalStores)}*\n`;
    t += `🚛 Поставщиков: *${n(s.users.totalSuppliers)}*\n`;
    t += `   ✅ Одобрено: ${n(s.users.approvedSuppliers)}  ⏳ На модерации: ${n(s.users.pendingSuppliers)}\n\n`;

    // Products
    t += `*📦 Товары*\n`;
    t += `🟢 Активных: *${n(s.products.active)}*  🗄 В архиве: *${n(s.products.archived)}*\n`;
    t += `👁 Просмотров всего: *${n(s.products.totalViews)}*\n\n`;

    // Requests
    t += `*📋 Заявки*\n`;
    t += `🟢 Открытых: *${n(s.requests.open)}*\n`;
    t += `✅ Завершённых: *${n(s.requests.completed)}*\n`;
    t += `❌ Отменённых: *${n(s.requests.cancelled)}*\n`;
    t += `💬 Всего предложений: *${n(s.requests.totalOffers)}*\n\n`;

    // Deals
    t += `*🤝 Сделки*\n`;
    t += `📅 На этой неделе: *${n(s.deals.thisWeek)}*\n`;
    t += `📅 В этом месяце: *${n(s.deals.thisMonth)}*\n`;
    t += `🏆 Всего: *${n(s.deals.total)}*\n\n`;

    // Top categories with bar chart
    if (s.topCategories.length) {
        t += `*📁 Топ категории*\n`;
        const maxCat = s.topCategories[0]?.count ?? 1;
        for (const c of s.topCategories) {
            t += `${e(c.category)} ${bar(c.count, maxCat)} ${n(c.count)}\n`;
        }
        t += '\n';
    }

    // Top suppliers
    if (s.topSuppliers.length) {
        t += `*🏆 Топ поставщики \\(по сделкам\\)*\n`;
        for (let i = 0; i < s.topSuppliers.length; i++) {
            const sup = s.topSuppliers[i];
            t += `${i + 1}\\. ${e(sup.supplierName)} — *${n(sup.deals)}* сделок\n`;
        }
        t += '\n';
    }

    // Most viewed
    if (s.mostViewedProducts.length) {
        t += `*👁 Самые просматриваемые товары*\n`;
        for (let i = 0; i < s.mostViewedProducts.length; i++) {
            const p = s.mostViewedProducts[i];
            t += `${i + 1}\\. ${e(p.name)} — *${n(p.views)}* 👁\n`;
        }
    }

    return t;
}