/**
 * mivra_search.ts — Smart Search Engine for MIVRA v7 (Task 4)
 *
 * Scoring weights (per matching term):
 *   Exact name match:    +100   Partial name:         +60
 *   Exact category:      +50    Partial category:     +30
 *   Supplier name:       +25    Description:          +10
 *   Popularity bonus:    +log(views+1) × 2
 *
 * Search pipeline:
 *   1. Expand query with synonym dictionary
 *   2. Try FTS5 (unicode61, handles Cyrillic) → get candidate IDs
 *   3. Score each candidate with weighted fields
 *   4. If FTS5 unavailable, fall back to multi-field LIKE
 *   5. Sort by score DESC, then views DESC
 *   6. Apply city/category hard filters
 *   7. Paginate
 */

import Database from 'better-sqlite3';
import type { Product } from './mivra_repos';

// ── Synonym dictionary ────────────────────────────────────────────────────────
// Bidirectional: searching "pampers" also finds products tagged "diapers" and vice-versa

const RAW_SYNONYMS: [string, string[]][] = [
  // Baby / hygiene
  ['памперс',      ['подгузник', 'подгузники', 'памперсы', 'diaper', 'diapers']],
  ['подгузник',    ['памперс', 'памперсы', 'diaper', 'diapers']],
  ['pampers',      ['памперс', 'подгузник', 'diaper', 'diapers']],
  ['diaper',       ['памперс', 'подгузник', 'diapers']],
  ['diapers',      ['памперс', 'подгузники', 'diaper']],
  ['детское',      ['baby', 'детский', 'детские', 'bola uchun']],
  ['baby',         ['детское', 'детский', 'детские', 'bola']],
  // Beverages
  ['напиток',      ['напитки', 'beverage', 'içimlik', 'ichimlik']],
  ['напитки',      ['напиток', 'beverages', 'ichimliklar']],
  ['beverage',     ['напиток', 'напитки', 'içimlik']],
  ['beverages',    ['напитки', 'ichimliklar']],
  ['газировка',    ['газированный', 'сода', 'кола', 'lemonad']],
  ['cola',         ['кола', 'газировка', 'soft drink']],
  ['кола',         ['cola', 'кока', 'газировка']],
  ['сок',          ['juice', 'sharbat', 'сокы']],
  ['juice',        ['сок', 'шарбат', 'sharbat']],
  ['вода',         ['water', 'минеральная', 'suv']],
  ['water',        ['вода', 'минеральная', 'suv']],
  // Dairy
  ['молоко',       ['dairy', 'молочный', 'sut', 'молочные']],
  ['dairy',        ['молоко', 'молочный', 'молочные']],
  ['молочный',     ['dairy', 'молоко', 'sut mahsulotlari']],
  // Cleaning / household
  ['моющее',       ['detergent', 'cleaning', 'yuvish', 'стиральный']],
  ['стиральный',   ['laundry', 'washing', 'kir yuvish', 'моющее']],
  ['detergent',    ['моющее', 'стиральный', 'yuvish vositasi']],
  ['порошок',      ['powder', 'kukun', 'стиральный']],
  // Food / snacks
  ['снек',         ['snack', 'snacks', 'печенье', 'чипсы', 'chips']],
  ['chips',        ['чипсы', 'чипс', 'снек', 'snack']],
  ['печенье',      ['biscuit', 'cookie', 'печенья', 'keks']],
  // Cosmetics
  ['косметика',    ['cosmetics', 'beauty', 'krем', 'shampoo', 'шампунь']],
  ['шампунь',      ['shampoo', 'kosmetika']],
  // Electronics
  ['телефон',      ['phone', 'smartphone', 'смартфон', 'mobil']],
  ['ноутбук',      ['laptop', 'noutbuk', 'notebook']],
  // Energy drinks
  ['энергетик',    ['energy drink', 'энергетический', 'energetik']],
  ['energy',       ['энергетик', 'энергетический']],
  // Tea / Coffee
  ['чай',          ['tea', 'choy']],
  ['tea',          ['чай', 'choy']],
  ['кофе',         ['coffee', 'kofe', 'qahva']],
  ['coffee',       ['кофе', 'kofe', 'qahva']],
  // Oil / Cooking
  ['масло',        ['oil', 'yog', "yog'"]],
  ['oil',          ['масло', 'yog']],
  // Sugar / Flour / Rice
  ['сахар',        ['sugar', 'shakar', 'qand']],
  ['мука',         ['flour', 'un']],
  ['рис',          ['rice', 'guruch']],
  // Meat
  ['мясо',         ['meat', "go'sht", 'gosht']],
];

// Build full bidirectional map
const SYNONYM_MAP = new Map<string, Set<string>>();
for (const [key, syns] of RAW_SYNONYMS) {
  const all = [key, ...syns];
  for (const word of all) {
    if (!SYNONYM_MAP.has(word)) SYNONYM_MAP.set(word, new Set());
    for (const other of all) {
      if (other !== word) SYNONYM_MAP.get(word)!.add(other);
    }
  }
}

export function expandQuery(raw: string): string[] {
  const terms = raw.toLowerCase().trim().split(/\s+/).filter(s => s.length >= 2);
  const expanded = new Set<string>(terms);
  for (const term of terms) {
    const syns = SYNONYM_MAP.get(term);
    if (syns) for (const s of syns) expanded.add(s);
  }
  return [...expanded];
}

// ── Filter & pagination type ──────────────────────────────────────────────────

export interface SearchFilter {
  q?:        string;
  city?:     string;
  category?: string;
}

// ── Row → Product ─────────────────────────────────────────────────────────────

function rowToProduct(row: any): Product & { deliveryScope: 'uzbekistan' | 'regional' } {
  return {
    id: row.id, supplierId: Number(row.supplier_id),
    supplierName: row.supplier_name ?? '', supplierPhone: row.supplier_phone ?? '',
    supplierUsername: row.supplier_username ?? undefined,
    name: row.name ?? '', category: row.category ?? '',
    description: row.description ?? '', weightVolume: row.weight_volume ?? '',
    unitsPerBox: row.units_per_box ?? '', minOrderQty: row.min_order_qty ?? '',
    price: row.price ?? '', priceNegotiable: Boolean(row.price_negotiable),
    deliveryAvailable: Boolean(row.delivery_available),
    city: row.city ?? '', availabilityStatus: row.availability_status ?? '',
    photos: (() => { try { return JSON.parse(row.photos || '[]'); } catch { return []; } })(),
    viewCount: Number(row.view_count ?? 0), createdAt: row.created_at,
    archived: Boolean(row.archived), contactClicks: Number(row.contact_clicks ?? 0),
    offerResponses: Number(row.offer_responses ?? 0), completedDeals: Number(row.completed_deals ?? 0),
    deliveryScope: (row.delivery_scope ?? 'regional') as 'uzbekistan' | 'regional',
  };
}

// ── Levenshtein distance for typo tolerance ───────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return d[m][n];
}

// ── Score function ─────────────────────────────────────────────────────────────

function scoreProduct(row: any, terms: string[]): number {
  const name = (row.name ?? '').toLowerCase();
  const cat  = (row.category ?? '').toLowerCase();
  const desc = (row.description ?? '').toLowerCase();
  const sup  = (row.supplier_name ?? '').toLowerCase();
  const viewBonus = Math.log((Number(row.view_count) || 0) + 1) * 2;
  const isFeatured = Boolean(row.is_featured);
  const isPro = Boolean(row.is_pro);

  let score = 0;
  for (const term of terms) {
    let termHit = false;
    if (name === term)             { score += 100; termHit = true; }
    else if (name.startsWith(term)) { score += 80; termHit = true; }
    else if (name.includes(term))  { score += 60; termHit = true; }

    if (cat === term)              { score += 50; termHit = true; }
    else if (cat.includes(term))   { score += 30; termHit = true; }

    if (sup.includes(term))        { score += 25; termHit = true; }
    if (desc.includes(term))       { score += 10; termHit = true; }

    // Fuzzy match for typo tolerance (only for terms >= 4 chars, no prior exact match)
    if (!termHit && term.length >= 4) {
      for (const w of name.split(/\s+/)) {
        if (w.length >= 3 && levenshtein(term, w) <= 1) { score += 40; break; }
      }
      for (const w of cat.split(/\s+/)) {
        if (w.length >= 3 && levenshtein(term, w) <= 1) { score += 20; break; }
      }
    }
  }
  
  // Apply PRO/Featured boost AFTER text scoring
  // PRO+Featured = always ranked at top in ANY search context
  if (isFeatured && isPro) {
    score = Math.max(score, 1) + 700;  // guaranteed top tier
  } else if (isFeatured) {
    score = Math.max(score, 1) + 500;  // guaranteed second tier
  } else if (isPro) {
    score = Math.max(score, 1) + 200;  // guaranteed third tier
  }
  
  return score > 0 ? score + viewBonus : 0;
}

// ── WHERE clause builder ──────────────────────────────────────────────────────

function filterClause(f?: SearchFilter): { sql: string; params: any[] } {
  const parts: string[] = [];
  const params: any[] = [];
  if (f?.city)     { parts.push("AND LOWER(p.city) = LOWER(?)"); params.push(f.city); }
  if (f?.category) { parts.push("AND LOWER(p.category) = LOWER(?)"); params.push(f.category); }
  return { sql: parts.join(' '), params };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function smartSearch(
  db: Database.Database,
  filter: SearchFilter,
  page = 0,
  pageSize = 10
): (Product & { deliveryScope: 'uzbekistan' | 'regional' })[] {

  const q = (filter.q ?? '').trim();
  const { sql: fSql, params: fParams } = filterClause(filter);

  // ── No query: sorted catalog ──────────────────────────────────────────────
  if (!q) {
    const rows = db.prepare(`
      SELECT p.*, u.is_pro FROM products p
      JOIN users u ON u.id = p.supplier_id
      WHERE p.archived = 0 AND u.role = 'supplier' AND u.approved = 1 AND u.suspended = 0
        ${fSql}
      ORDER BY p.is_featured DESC, u.is_pro DESC, p.view_count DESC, p.created_at DESC
      LIMIT ? OFFSET ?
    `).all([...fParams, pageSize, page * pageSize]) as any[];
    return rows.map(rowToProduct);
  }

  const terms = expandQuery(q);

  // ── Try FTS5 to get candidate IDs ─────────────────────────────────────────
  let candidateIds: Set<string> | null = null;
  try {
    // FTS5 MATCH syntax: quote each term to handle special chars, join with OR
    const ftsQ = terms
      .filter(t => t.length >= 2)
      .map(t => `"${t.replace(/"/g, '""')}"`)
      .join(' OR ');
    const ftsRows = db.prepare(
      'SELECT product_id FROM products_fts WHERE search_text MATCH ? ORDER BY rank LIMIT 300'
    ).all(ftsQ) as any[];
    if (ftsRows.length > 0) {
      candidateIds = new Set(ftsRows.map(r => r.product_id as string));
    }
  } catch {
    // FTS5 not available or query syntax error — fall through to LIKE
  }

  // ── Fetch candidate rows ──────────────────────────────────────────────────
  let rows: any[];
  if (candidateIds && candidateIds.size > 0) {
    const ph = [...candidateIds].map(() => '?').join(',');
    rows = db.prepare(`
      SELECT p.*, u.is_pro FROM products p
      JOIN users u ON u.id = p.supplier_id
      WHERE p.archived = 0 AND u.role = 'supplier' AND u.approved = 1 AND u.suspended = 0
        AND p.id IN (${ph})
        ${fSql}
    `).all([...candidateIds, ...fParams]) as any[];
  } else {
    // LIKE fallback — search all active products
    const likeParts = terms.flatMap(() => [
      'LOWER(p.name) LIKE ?', 'LOWER(p.category) LIKE ?',
      'LOWER(p.description) LIKE ?', 'LOWER(p.supplier_name) LIKE ?',
    ]);
    const likeParams = terms.flatMap(t => {
      const pat = `%${t}%`;
      return [pat, pat, pat, pat];
    });
    rows = db.prepare(`
      SELECT p.*, u.is_pro FROM products p
      JOIN users u ON u.id = p.supplier_id
      WHERE p.archived = 0 AND u.role = 'supplier' AND u.approved = 1 AND u.suspended = 0
        AND (${likeParts.join(' OR ')})
        ${fSql}
    `).all([...likeParams, ...fParams]) as any[];
  }

  // ── Score + filter + sort ─────────────────────────────────────────────────
  const scored = rows
    .map(row => ({ row, score: scoreProduct(row, terms) }))
    .filter(x => x.score > 0 || !!candidateIds) // keep all FTS hits
    .sort((a, b) => b.score - a.score || Number(b.row.view_count) - Number(a.row.view_count));

  // ── Paginate ──────────────────────────────────────────────────────────────
  return scored
    .slice(page * pageSize, (page + 1) * pageSize)
    .map(x => rowToProduct(x.row));
}

/** Returns distinct cities + categories visible in the active catalog */
export function getCatalogMeta(db: Database.Database): { cities: string[]; categories: string[] } {
  const rows = db.prepare(`
    SELECT DISTINCT p.city, p.category FROM products p
    JOIN users u ON u.id = p.supplier_id
    WHERE p.archived = 0 AND u.role = 'supplier' AND u.approved = 1 AND u.suspended = 0
  `).all() as any[];
  return {
    cities:     [...new Set(rows.map(r => r.city).filter(Boolean))].sort().slice(0, 15) as string[],
    categories: [...new Set(rows.map(r => r.category).filter(Boolean))].sort().slice(0, 15) as string[],
  };
}

/** Total number of matching results (for pagination UI) */
export function searchCount(db: Database.Database, filter: SearchFilter): number {
  const { sql: fSql, params: fParams } = filterClause(filter);
  if (!filter.q) {
    return (db.prepare(`
      SELECT COUNT(*) AS c FROM products p
      JOIN users u ON u.id = p.supplier_id
      WHERE p.archived=0 AND u.role='supplier' AND u.approved=1 AND u.suspended=0 ${fSql}
    `).get(fParams) as any)?.c ?? 0;
  }
  // For text search, use FTS5 count when available
  const terms = expandQuery(filter.q);
  try {
    const ftsQ = terms
      .filter(t => t.length >= 2)
      .map(t => `"${t.replace(/"/g, '""')}"`)
      .join(' OR ');
    if (ftsQ) {
      const count = (db.prepare(
        'SELECT COUNT(*) AS c FROM products_fts WHERE search_text MATCH ?'
      ).get(ftsQ) as any)?.c ?? 0;
      return count;
    }
  } catch { /* FTS5 not available, fall through */ }
  // Fallback: count with LIKE (avoids loading full rows)
  const likeParts = terms.flatMap(() => [
    'LOWER(p.name) LIKE ?', 'LOWER(p.category) LIKE ?',
    'LOWER(p.description) LIKE ?', 'LOWER(p.supplier_name) LIKE ?',
  ]);
  const likeParams = terms.flatMap(t => {
    const pat = `%${t}%`;
    return [pat, pat, pat, pat];
  });
  return (db.prepare(`
    SELECT COUNT(*) AS c FROM products p
    JOIN users u ON u.id = p.supplier_id
    WHERE p.archived=0 AND u.role='supplier' AND u.approved=1 AND u.suspended=0
      AND (${likeParts.join(' OR ')})
      ${fSql}
  `).get([...likeParams, ...fParams]) as any)?.c ?? 0;
}