/**
 * mivra_repos.ts — Repository Layer for MIVRA v7
 *
 * Each repository owns exactly one logical domain.
 * All methods are synchronous (better-sqlite3).
 *
 * Usage:
 *   import { createRepos } from './mivra_repos';
 *   const repos = createRepos(getDb());
 */

import Database from 'better-sqlite3';

// ── Re-export all shared types ────────────────────────────────────────────────
// (These are identical to the originals in mivra_bot.ts / mivra_bot_v7.ts)

export type Lang = 'ru' | 'uz';
export type SupplierTier = 'free' | 'premium' | 'enterprise';
export type OfferStatus = 'pending' | 'accepted' | 'rejected';
export type ReqStatus = 'active' | 'offer_received' | 'accepted' | 'delivered' | 'completed' | 'cancelled';
export type AnalyticsEventType = 'view' | 'contact' | 'offer' | 'deal';

export interface RegularUser {
  id: number; firstName: string; username?: string;
  role: 'user'; lang: Lang; registeredAt: string;
  isPro?: boolean; proUntil?: string;
}
export interface StoreUser {
  id: number; firstName: string; username?: string;
  role: 'store'; lang: Lang;
  storeName: string; phone: string; city: string;
  registeredAt: string; favorites: string[];
  isPro?: boolean; proUntil?: string;
}
export interface SupplierUser {
  id: number; firstName: string; username?: string;
  role: 'supplier'; lang: Lang;
  companyName: string; contactPerson: string; phone: string;
  city: string; businessDescription: string;
  approved: boolean; suspended: boolean;
  registeredAt: string; categories: string[]; tier: SupplierTier;
  isPro?: boolean; proUntil?: string;
}
export type User = RegularUser | StoreUser | SupplierUser;

export interface Offer {
  id: string; supplierId: number; supplierName: string; supplierPhone: string;
  supplierUsername?: string; price: string; deliveryAvailable: boolean;
  priceNegotiable: boolean; estimatedDelivery: string; comment: string;
  status: OfferStatus; createdAt: string;
}
export interface StatusHistoryEntry { status: ReqStatus; at: string; }
export interface Request {
  id: string; storeId: number; storeName: string; storePhone: string;
  storeUsername?: string; product: string; category: string;
  specification: string; quantity: string; unitType: string;
  city: string; deliveryAddress: string; requiredDate: string;
  additionalNotes: string; createdAt: string; status: ReqStatus;
  offers: Offer[]; acceptedOfferId?: string; statusHistory: StatusHistoryEntry[];
}
export interface Product {
  id: string; supplierId: number; supplierName: string; supplierPhone: string;
  supplierUsername?: string; name: string; category: string; description: string;
  weightVolume: string; unitsPerBox: string; minOrderQty: string; price: string;
  priceNegotiable: boolean; deliveryAvailable: boolean; city: string;
  availabilityStatus: string; photos: string[]; viewCount: number;
  createdAt: string; archived: boolean; contactClicks: number;
  offerResponses: number; completedDeals: number;
  deliveryScope?: string;
  isFeatured?: boolean; featuredUntil?: string;
}
export interface Transaction {
  id: string; mivraTxId: string; userId: number; productId?: string;
  type: 'PRO' | 'FEATURED'; amount: number; status: 'pending' | 'completed' | 'cancelled';
  createdAt: string; updatedAt: string; performTime?: string; cancelTime?: string;
}
export type TxStatus = 'pending' | 'completed' | 'cancelled';

/** Allowed state transitions. Any other transition throws. */
const ALLOWED_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  pending:   ['completed', 'cancelled'],
  completed: ['cancelled'],          // accounting only
  cancelled: [],                     // terminal
};

export interface Refund {
  id: string; transactionId: string; adminId: number; reason: string;
  amount: number; revokeService: boolean;
  status: 'pending' | 'completed' | 'rejected';
  createdAt: string; completedAt?: string;
}
export interface DealRecord {
  id: string; requestId: string; storeName: string; storeId: number;
  supplierName: string; supplierId: number; product: string;
  quantity: string; unitType: string; price: string; completedAt: string;
  productId?: string;
}
export interface AnalyticsEvent {
  type: AnalyticsEventType; productId: string;
  supplierId: number; userId: number; at: string;
}

// ── Row → Domain object converters ───────────────────────────────────────────

function rowToUser(row: any, favorites: string[] = []): User {
  const base = {
    id: Number(row.id),
    firstName: row.first_name ?? '',
    username: row.username ?? undefined,
    lang: (row.lang === 'uz' ? 'uz' : 'ru') as Lang,
    registeredAt: row.registered_at,
    isPro: Boolean(row.is_pro),
    proUntil: row.pro_until ?? undefined,
  };
  if (row.role === 'store') return {
    ...base, role: 'store',
    storeName: row.store_name ?? '', phone: row.phone ?? '',
    city: row.city ?? '', favorites,
  };
  if (row.role === 'supplier') return {
    ...base, role: 'supplier',
    companyName: row.company_name ?? '', contactPerson: row.contact_person ?? '',
    phone: row.phone ?? '', city: row.city ?? '',
    businessDescription: row.business_description ?? '',
    approved: Boolean(row.approved), suspended: Boolean(row.suspended),
    categories: safeJsonParse(row.categories, []),
    tier: (['free', 'premium', 'enterprise'].includes(row.tier) ? row.tier : 'free') as SupplierTier,
  };
  return { ...base, role: 'user' };
}

function rowToProduct(row: any): Product {
  return {
    id: row.id,
    supplierId: Number(row.supplier_id),
    supplierName: row.supplier_name ?? '',
    supplierPhone: row.supplier_phone ?? '',
    supplierUsername: row.supplier_username ?? undefined,
    name: row.name ?? '',
    category: row.category ?? '',
    description: row.description ?? '',
    weightVolume: row.weight_volume ?? '',
    unitsPerBox: row.units_per_box ?? '',
    minOrderQty: row.min_order_qty ?? '',
    price: row.price ?? '',
    priceNegotiable: Boolean(row.price_negotiable),
    deliveryAvailable: Boolean(row.delivery_available),
    city: row.city ?? '',
    availabilityStatus: row.availability_status ?? '',
    photos: safeJsonParse(row.photos, []),
    viewCount: Number(row.view_count ?? 0),
    createdAt: row.created_at,
    archived: Boolean(row.archived),
    contactClicks: Number(row.contact_clicks ?? 0),
    offerResponses: Number(row.offer_responses ?? 0),
    completedDeals: Number(row.completed_deals ?? 0),
    deliveryScope: row.delivery_scope ?? 'regional',
    isFeatured: Boolean(row.is_featured),
    featuredUntil: row.featured_until ?? undefined,
  };
}

function rowToOffer(row: any): Offer {
  return {
    id: row.id,
    supplierId: Number(row.supplier_id),
    supplierName: row.supplier_name ?? '',
    supplierPhone: row.supplier_phone ?? '',
    supplierUsername: row.supplier_username ?? undefined,
    price: row.price ?? '',
    deliveryAvailable: Boolean(row.delivery_available),
    priceNegotiable: Boolean(row.price_negotiable),
    estimatedDelivery: row.estimated_delivery ?? '',
    comment: row.comment ?? '',
    status: (row.status as OfferStatus) ?? 'pending',
    createdAt: row.created_at,
  };
}

function rowToRequest(row: any, offers: Offer[] = []): Request {
  const VALID: ReqStatus[] = ['active', 'offer_received', 'accepted', 'delivered', 'completed', 'cancelled'];
  return {
    id: row.id,
    storeId: Number(row.store_id),
    storeName: row.store_name ?? '',
    storePhone: row.store_phone ?? '',
    storeUsername: row.store_username ?? undefined,
    product: row.product ?? '',
    category: row.category ?? '',
    specification: row.specification ?? '',
    quantity: row.quantity ?? '',
    unitType: row.unit_type ?? '',
    city: row.city ?? '',
    deliveryAddress: row.delivery_address ?? '',
    requiredDate: row.required_date ?? '',
    additionalNotes: row.additional_notes ?? '',
    createdAt: row.created_at,
    status: VALID.includes(row.status) ? row.status as ReqStatus : 'active',
    offers,
    acceptedOfferId: row.accepted_offer_id ?? undefined,
    statusHistory: safeJsonParse(row.status_history, []),
  };
}

function rowToDeal(row: any): DealRecord {
  return {
    id: row.id, requestId: row.request_id,
    storeName: row.store_name ?? '', storeId: Number(row.store_id),
    supplierName: row.supplier_name ?? '', supplierId: Number(row.supplier_id),
    product: row.product ?? '', quantity: row.quantity ?? '',
    unitType: row.unit_type ?? '', price: row.price ?? '',
    completedAt: row.completed_at, productId: row.product_id ?? undefined,
  };
}

function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; }
}

// ── UserRepository ────────────────────────────────────────────────────────────

export class UserRepository {
  constructor(private db: Database.Database) { }

  findById(id: number): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) return undefined;
    const favs = (this.db.prepare('SELECT product_id FROM favorites WHERE user_id = ?').all(id) as any[])
      .map(r => r.product_id as string);
    return rowToUser(row, favs);
  }

  findAll(): User[] {
    const rows = this.db.prepare('SELECT * FROM users').all() as any[];
    // Batch-load all favorites in one query to avoid N+1
    const allFavs = this.db.prepare('SELECT user_id, product_id FROM favorites').all() as any[];
    const favMap = new Map<number, string[]>();
    for (const f of allFavs) {
      if (!favMap.has(f.user_id)) favMap.set(f.user_id, []);
      favMap.get(f.user_id)!.push(f.product_id);
    }
    return rows.map(r => rowToUser(r, favMap.get(r.id) ?? []));
  }

  findSuppliers(): SupplierUser[] {
    return (this.db.prepare("SELECT * FROM users WHERE role = 'supplier' ORDER BY registered_at DESC").all() as any[])
      .map(r => rowToUser(r) as SupplierUser);
  }

  findApprovedActiveSuppliers(): SupplierUser[] {
    return (this.db.prepare(
      "SELECT * FROM users WHERE role = 'supplier' AND approved = 1 AND suspended = 0"
    ).all() as any[]).map(r => rowToUser(r) as SupplierUser);
  }

  save(user: User): void {
    const isSup = user.role === 'supplier';
    const isSt = user.role === 'store';
    this.db.prepare(`
      INSERT INTO users
        (id, role, first_name, username, lang, registered_at,
         store_name, company_name, contact_person, phone, city,
         business_description, approved, suspended, tier, categories,
         is_pro, pro_until)
      VALUES
        (@id, @role, @firstName, @username, @lang, @registeredAt,
         @storeName, @companyName, @contactPerson, @phone, @city,
         @businessDescription, @approved, @suspended, @tier, @categories,
         @isPro, @proUntil)
      ON CONFLICT(id) DO UPDATE SET
        role=excluded.role, first_name=excluded.first_name,
        username=excluded.username, lang=excluded.lang,
        store_name=excluded.store_name, company_name=excluded.company_name,
        contact_person=excluded.contact_person, phone=excluded.phone,
        city=excluded.city, business_description=excluded.business_description,
        approved=excluded.approved, suspended=excluded.suspended,
        tier=excluded.tier, categories=excluded.categories,
        is_pro=excluded.is_pro, pro_until=excluded.pro_until
    `).run({
      id: user.id, role: user.role,
      firstName: user.firstName, username: user.username ?? null,
      lang: user.lang, registeredAt: user.registeredAt,
      storeName: isSt ? (user as StoreUser).storeName : null,
      companyName: isSup ? (user as SupplierUser).companyName : null,
      contactPerson: isSup ? (user as SupplierUser).contactPerson : null,
      phone: (isSt || isSup) ? (user as any).phone : null,
      city: (isSt || isSup) ? (user as any).city : null,
      businessDescription: isSup ? (user as SupplierUser).businessDescription : null,
      approved: isSup ? Number((user as SupplierUser).approved) : 0,
      suspended: isSup ? Number((user as SupplierUser).suspended) : 0,
      tier: isSup ? (user as SupplierUser).tier : 'free',
      categories: isSup ? JSON.stringify((user as SupplierUser).categories) : '[]',
      isPro: Number(user.isPro ?? 0),
      proUntil: user.proUntil ?? null,
    });

    // Sync favorites for store users
    if (isSt) {
      const favs = (user as StoreUser).favorites;
      this.db.prepare('DELETE FROM favorites WHERE user_id = ?').run(user.id);
      const ins = this.db.prepare(`
        INSERT INTO favorites (user_id, product_id)
        SELECT ?, ?
        WHERE EXISTS (
            SELECT 1
            FROM products
            WHERE id = ?
    )
`);

      for (const pid of favs) {
        ins.run(user.id, pid, pid);
      }
    }
  }

  addFavorite(userId: number, productId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO favorites (user_id, product_id) VALUES (?, ?)').run(userId, productId);
  }

  removeFavorite(userId: number, productId: string): void {
    this.db.prepare('DELETE FROM favorites WHERE user_id = ? AND product_id = ?').run(userId, productId);
  }

  hasFavorite(userId: number, productId: string): boolean {
    return !!(this.db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND product_id = ?').get(userId, productId));
  }

  getFavorites(userId: number): string[] {
    return (this.db.prepare('SELECT product_id FROM favorites WHERE user_id = ?').all(userId) as any[])
      .map(r => r.product_id as string);
  }

  count(): { stores: number; suppliers: number; approvedSuppliers: number; pendingSuppliers: number } {
    const r = this.db.prepare(`
      SELECT
        SUM(CASE WHEN role='store' THEN 1 ELSE 0 END)                          AS stores,
        SUM(CASE WHEN role='supplier' THEN 1 ELSE 0 END)                       AS suppliers,
        SUM(CASE WHEN role='supplier' AND approved=1 THEN 1 ELSE 0 END)        AS approved_sups,
        SUM(CASE WHEN role='supplier' AND approved=0 THEN 1 ELSE 0 END)        AS pending_sups
      FROM users
    `).get() as any;
    return {
      stores: Number(r.stores ?? 0),
      suppliers: Number(r.suppliers ?? 0),
      approvedSuppliers: Number(r.approved_sups ?? 0),
      pendingSuppliers: Number(r.pending_sups ?? 0),
    };
  }
}

// ── ProductRepository ─────────────────────────────────────────────────────────

export interface PaginationOptions {
  supplierId?: number;
  category?: string;
  limit: number;
  cursor?: { createdAt: string; id: string } | null;
  includeArchived?: boolean;
}

export class ProductRepository {
  constructor(private db: Database.Database) { }

  findById(id: string): Product | undefined {
    const row = this.db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    return row ? rowToProduct(row) : undefined;
  }

  findBySupplierId(supplierId: number, includeArchived = false): Product[] {
    const sql = includeArchived
      ? 'SELECT * FROM products WHERE supplier_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM products WHERE supplier_id = ? AND archived = 0 ORDER BY created_at DESC';
    return (this.db.prepare(sql).all(supplierId) as any[]).map(rowToProduct);
  }

  findAll(includeArchived = true): Product[] {
    const sql = includeArchived
      ? 'SELECT * FROM products ORDER BY created_at DESC'
      : 'SELECT * FROM products WHERE archived = 0 ORDER BY created_at DESC';
    return (this.db.prepare(sql).all() as any[]).map(rowToProduct);
  }

  findRecent(limit = 10, includeArchived = true): Product[] {
    const sql = includeArchived
      ? 'SELECT * FROM products ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM products WHERE archived = 0 ORDER BY created_at DESC LIMIT ?';
    return (this.db.prepare(sql).all(limit) as any[]).map(rowToProduct);
  }

  /** Active products from approved, non-suspended suppliers */
  findActiveCatalog(): Product[] {
    return (this.db.prepare(`
      SELECT p.* FROM products p
      JOIN users u ON u.id = p.supplier_id
      WHERE p.archived = 0 AND u.role = 'supplier' AND u.approved = 1 AND u.suspended = 0
      ORDER BY p.created_at DESC
    `).all() as any[]).map(rowToProduct);
  }

  countActiveForSupplier(supplierId: number): number {
    return (this.db.prepare(
      'SELECT COUNT(*) AS c FROM products WHERE supplier_id = ? AND archived = 0'
    ).get(supplierId) as any)?.c ?? 0;
  }

  findPaginated(opts: PaginationOptions): { items: Product[]; nextCursor: { createdAt: string; id: string } | null } {
    let sql = 'SELECT * FROM products WHERE 1=1';
    const params: any[] = [];
    if (opts.supplierId !== undefined) { sql += ' AND supplier_id = ?'; params.push(opts.supplierId); }
    if (opts.category && opts.category !== 'All') { sql += ' AND category = ?'; params.push(opts.category); }
    if (!opts.includeArchived) { sql += ' AND archived = 0'; }
    if (opts.cursor) {
      sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      params.push(opts.cursor.createdAt, opts.cursor.createdAt, opts.cursor.id);
    }
    sql += ' ORDER BY is_featured DESC, created_at DESC, id DESC LIMIT ?';
    params.push(opts.limit + 1);
    const rows = this.db.prepare(sql).all(...params) as any[];
    const hasNext = rows.length > opts.limit;
    const items = rows.slice(0, opts.limit).map(rowToProduct);
    let nextCursor = null;
    if (hasNext) {
      const last = items[items.length - 1];
      nextCursor = { createdAt: last.createdAt, id: last.id };
    }
    return { items, nextCursor };
  }

  save(product: Product): void {
    this.db.prepare(`
      INSERT INTO products
        (id, supplier_id, supplier_name, supplier_phone, supplier_username,
         name, category, description, weight_volume, units_per_box, min_order_qty,
         price, price_negotiable, delivery_available, city, availability_status,
         photos, view_count, contact_clicks, offer_responses, completed_deals,
         created_at, archived, delivery_scope, is_featured, featured_until)
      VALUES
        (@id, @supplierId, @supplierName, @supplierPhone, @supplierUsername,
         @name, @category, @description, @weightVolume, @unitsPerBox, @minOrderQty,
         @price, @priceNegotiable, @deliveryAvailable, @city, @availabilityStatus,
         @photos, @viewCount, @contactClicks, @offerResponses, @completedDeals,
         @createdAt, @archived, @deliveryScope, @isFeatured, @featuredUntil)
      ON CONFLICT(id) DO UPDATE SET
        supplier_id=excluded.supplier_id, supplier_name=excluded.supplier_name,
        supplier_phone=excluded.supplier_phone, supplier_username=excluded.supplier_username,
        name=excluded.name, category=excluded.category, description=excluded.description,
        weight_volume=excluded.weight_volume, units_per_box=excluded.units_per_box,
        min_order_qty=excluded.min_order_qty, price=excluded.price,
        price_negotiable=excluded.price_negotiable, delivery_available=excluded.delivery_available,
        city=excluded.city, availability_status=excluded.availability_status,
        photos=excluded.photos, view_count=excluded.view_count,
        contact_clicks=excluded.contact_clicks, offer_responses=excluded.offer_responses,
        completed_deals=excluded.completed_deals, archived=excluded.archived,
        delivery_scope=excluded.delivery_scope, is_featured=excluded.is_featured,
        featured_until=excluded.featured_until
    `).run({
      id: product.id, supplierId: product.supplierId,
      supplierName: product.supplierName, supplierPhone: product.supplierPhone,
      supplierUsername: product.supplierUsername ?? null,
      name: product.name, category: product.category, description: product.description,
      weightVolume: product.weightVolume, unitsPerBox: product.unitsPerBox,
      minOrderQty: product.minOrderQty, price: product.price,
      priceNegotiable: Number(product.priceNegotiable),
      deliveryAvailable: Number(product.deliveryAvailable),
      city: product.city, availabilityStatus: product.availabilityStatus,
      photos: JSON.stringify(product.photos),
      viewCount: product.viewCount, contactClicks: product.contactClicks,
      offerResponses: product.offerResponses, completedDeals: product.completedDeals,
      createdAt: product.createdAt, archived: Number(product.archived),
      deliveryScope: product.deliveryScope ?? 'regional',
      isFeatured: Number(product.isFeatured ?? 0),
      featuredUntil: product.featuredUntil ?? null,
    });
    this.upsertFts(product);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM products_fts WHERE product_id = ?').run(id);
    this.db.prepare('DELETE FROM products WHERE id = ?').run(id);
  }

  incrementView(id: string): void {
    this.db.prepare('UPDATE products SET view_count = view_count + 1 WHERE id = ?').run(id);
  }

  incrementContact(id: string): void {
    this.db.prepare('UPDATE products SET contact_clicks = contact_clicks + 1 WHERE id = ?').run(id);
  }

  incrementOfferResponses(id: string): void {
    this.db.prepare('UPDATE products SET offer_responses = offer_responses + 1 WHERE id = ?').run(id);
  }

  incrementCompletedDeals(id: string): void {
    this.db.prepare('UPDATE products SET completed_deals = completed_deals + 1 WHERE id = ?').run(id);
  }

  setArchived(id: string, archived: boolean): void {
    this.db.prepare('UPDATE products SET archived = ? WHERE id = ?').run(Number(archived), id);
    if (archived) this.db.prepare('DELETE FROM products_fts WHERE product_id = ?').run(id);
    else {
      const p = this.findById(id);
      if (p) this.upsertFts(p);
    }
  }

  private upsertFts(product: Product): void {
    const text = [product.name, product.category, product.description, product.supplierName, product.city]
      .filter(Boolean).join(' ');
    this.db.prepare('DELETE FROM products_fts WHERE product_id = ?').run(product.id);
    if (!product.archived) {
      this.db.prepare('INSERT INTO products_fts (product_id, search_text) VALUES (?, ?)').run(product.id, text);
    }
  }

  /** Used for admin analytics */
  stats(): { active: number; archived: number; totalViews: number } {
    const r = this.db.prepare(`
      SELECT
        SUM(CASE WHEN archived=0 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) AS archived,
        SUM(view_count) AS total_views
      FROM products
    `).get() as any;
    return {
      active: Number(r?.active ?? 0),
      archived: Number(r?.archived ?? 0),
      totalViews: Number(r?.total_views ?? 0),
    };
  }

  topByViews(limit = 5): Product[] {
    return (this.db.prepare(
      'SELECT * FROM products WHERE archived = 0 ORDER BY view_count DESC LIMIT ?'
    ).all(limit) as any[]).map(rowToProduct);
  }

  topCategories(limit = 8): Array<{ category: string; count: number }> {
    return (this.db.prepare(`
      SELECT category, COUNT(*) AS count FROM products
      WHERE archived = 0 GROUP BY category ORDER BY count DESC LIMIT ?
    `).all(limit) as any[]).map(r => ({ category: r.category, count: Number(r.count) }));
  }
}

// ── RequestRepository ─────────────────────────────────────────────────────────

export class RequestRepository {
  constructor(private db: Database.Database) { }

  private loadOffers(requestId: string): Offer[] {
    return (this.db.prepare(
      'SELECT * FROM offers WHERE request_id = ? ORDER BY created_at ASC'
    ).all(requestId) as any[]).map(rowToOffer);
  }

  findById(id: string): Request | undefined {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    if (!row) return undefined;
    return rowToRequest(row, this.loadOffers(id));
  }

  findAll(): Request[] {
    return (this.db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all() as any[])
      .map(r => rowToRequest(r, this.loadOffers(r.id)));
  }

  findByStore(storeId: number): Request[] {
    return (this.db.prepare(
      'SELECT * FROM requests WHERE store_id = ? ORDER BY created_at DESC'
    ).all(storeId) as any[]).map(r => rowToRequest(r, this.loadOffers(r.id)));
  }

  findOpen(): Request[] {
    return (this.db.prepare(
      "SELECT * FROM requests WHERE status IN ('active','offer_received') ORDER BY created_at DESC"
    ).all() as any[]).map(r => rowToRequest(r, this.loadOffers(r.id)));
  }

  findRecent(limit = 10): Request[] {
    return (this.db.prepare(
      'SELECT * FROM requests ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as any[]).map(r => rowToRequest(r, this.loadOffers(r.id)));
  }

  isDuplicate(storeId: number, product: string, quantity: string, city: string): boolean {
    const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
    return !!(this.db.prepare(`
      SELECT 1 FROM requests
      WHERE store_id = ? AND LOWER(product) = LOWER(?)
        AND quantity = ? AND LOWER(city) = LOWER(?)
        AND status NOT IN ('cancelled','completed')
        AND created_at > ?
    `).get(storeId, product, quantity, city, cutoff));
  }

  save(req: Request): void {
    this.db.prepare(`
      INSERT INTO requests
        (id, store_id, store_name, store_phone, store_username,
         product, category, specification, quantity, unit_type,
         city, delivery_address, required_date, additional_notes,
         created_at, status, accepted_offer_id, status_history)
      VALUES
        (@id, @storeId, @storeName, @storePhone, @storeUsername,
         @product, @category, @specification, @quantity, @unitType,
         @city, @deliveryAddress, @requiredDate, @additionalNotes,
         @createdAt, @status, @acceptedOfferId, @statusHistory)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, accepted_offer_id=excluded.accepted_offer_id,
        status_history=excluded.status_history
    `).run({
      id: req.id, storeId: req.storeId, storeName: req.storeName,
      storePhone: req.storePhone, storeUsername: req.storeUsername ?? null,
      product: req.product, category: req.category,
      specification: req.specification, quantity: req.quantity,
      unitType: req.unitType, city: req.city,
      deliveryAddress: req.deliveryAddress, requiredDate: req.requiredDate,
      additionalNotes: req.additionalNotes, createdAt: req.createdAt,
      status: req.status, acceptedOfferId: req.acceptedOfferId ?? null,
      statusHistory: JSON.stringify(req.statusHistory),
    });
    // Save all offers (INSERT OR REPLACE)
    const insOffer = this.db.prepare(`
      INSERT INTO offers
        (id, request_id, supplier_id, supplier_name, supplier_phone, supplier_username,
         price, delivery_available, price_negotiable, estimated_delivery, comment,
         status, created_at)
      VALUES
        (@id, @requestId, @supplierId, @supplierName, @supplierPhone, @supplierUsername,
         @price, @deliveryAvailable, @priceNegotiable, @estimatedDelivery, @comment,
         @status, @createdAt)
      ON CONFLICT(id) DO UPDATE SET
        price=excluded.price, delivery_available=excluded.delivery_available,
        price_negotiable=excluded.price_negotiable,
        estimated_delivery=excluded.estimated_delivery, comment=excluded.comment,
        status=excluded.status, created_at=excluded.created_at
    `);
    for (const o of req.offers) {
      insOffer.run({
        id: o.id, requestId: req.id, supplierId: o.supplierId,
        supplierName: o.supplierName, supplierPhone: o.supplierPhone,
        supplierUsername: o.supplierUsername ?? null,
        price: o.price, deliveryAvailable: Number(o.deliveryAvailable),
        priceNegotiable: Number(o.priceNegotiable),
        estimatedDelivery: o.estimatedDelivery, comment: o.comment,
        status: o.status, createdAt: o.createdAt,
      });
    }
  }

  updateStatus(id: string, status: ReqStatus, acceptedOfferId?: string): void {
    const history = (this.db.prepare(
      'SELECT status_history FROM requests WHERE id = ?'
    ).get(id) as any)?.status_history ?? '[]';
    const hist: StatusHistoryEntry[] = safeJsonParse(history, []);
    hist.push({ status, at: new Date().toISOString() });
    this.db.prepare(`
      UPDATE requests SET status=?, accepted_offer_id=?, status_history=? WHERE id=?
    `).run(status, acceptedOfferId ?? null, JSON.stringify(hist), id);
  }

  updateOfferStatus(offerId: string, status: OfferStatus): void {
    this.db.prepare('UPDATE offers SET status = ? WHERE id = ?').run(status, offerId);
  }

  rejectOtherOffers(requestId: string, exceptOfferId: string): void {
    this.db.prepare(
      "UPDATE offers SET status='rejected' WHERE request_id=? AND id!=? AND status='pending'"
    ).run(requestId, exceptOfferId);
  }

  updateOffer(offerId: string, fields: Partial<Pick<Offer, 'price' | 'estimatedDelivery'>>): void {
    if (fields.price !== undefined)
      this.db.prepare('UPDATE offers SET price=?, created_at=? WHERE id=?')
        .run(fields.price, new Date().toISOString(), offerId);
    if (fields.estimatedDelivery !== undefined)
      this.db.prepare('UPDATE offers SET estimated_delivery=? WHERE id=?')
        .run(fields.estimatedDelivery, offerId);
  }

  hasOffer(supplierId: number, requestId: string): boolean {
    return !!(this.db.prepare(
      'SELECT 1 FROM offers WHERE supplier_id=? AND request_id=? AND status != ?'
    ).get(supplierId, requestId, 'rejected'));
  }

  stats(): { open: number; completed: number; cancelled: number } {
    const r = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('active','offer_received') THEN 1 ELSE 0 END) AS open_r,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END)                    AS completed_r,
        SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END)                    AS cancelled_r
      FROM requests
    `).get() as any;
    return {
      open: Number(r?.open_r ?? 0),
      completed: Number(r?.completed_r ?? 0),
      cancelled: Number(r?.cancelled_r ?? 0),
    };
  }
}

// ── DealRepository ────────────────────────────────────────────────────────────

export class DealRepository {
  constructor(private db: Database.Database) { }

  findAll(): DealRecord[] {
    return (this.db.prepare('SELECT * FROM deals ORDER BY completed_at DESC').all() as any[]).map(rowToDeal);
  }

  findBySupplierId(supplierId: number): DealRecord[] {
    return (this.db.prepare(
      'SELECT * FROM deals WHERE supplier_id = ? ORDER BY completed_at DESC'
    ).all(supplierId) as any[]).map(rowToDeal);
  }

  countBySupplierId(supplierId: number): number {
    return (this.db.prepare(
      'SELECT COUNT(*) AS c FROM deals WHERE supplier_id = ?'
    ).get(supplierId) as any)?.c ?? 0;
  }

  findByStoreId(storeId: number): DealRecord[] {
    return (this.db.prepare(
      'SELECT * FROM deals WHERE store_id = ? ORDER BY completed_at DESC'
    ).all(storeId) as any[]).map(rowToDeal);
  }

  save(deal: DealRecord): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO deals
        (id, request_id, store_name, store_id, supplier_name, supplier_id,
         product, quantity, unit_type, price, completed_at, product_id)
      VALUES
        (@id, @requestId, @storeName, @storeId, @supplierName, @supplierId,
         @product, @quantity, @unitType, @price, @completedAt, @productId)
    `).run({
      id: deal.id, requestId: deal.requestId,
      storeName: deal.storeName, storeId: deal.storeId,
      supplierName: deal.supplierName, supplierId: deal.supplierId,
      product: deal.product, quantity: deal.quantity, unitType: deal.unitType,
      price: deal.price, completedAt: deal.completedAt,
      productId: deal.productId ?? null,
    });
  }

  stats(): { total: number; thisWeek: number; thisMonth: number } {
    const r = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN completed_at >= datetime('now','-7 days') THEN 1 ELSE 0 END)  AS this_week,
        SUM(CASE WHEN completed_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS this_month
      FROM deals
    `).get() as any;
    return {
      total: Number(r?.total ?? 0),
      thisWeek: Number(r?.this_week ?? 0),
      thisMonth: Number(r?.this_month ?? 0),
    };
  }

  topSuppliers(limit = 5): Array<{ supplierId: number; supplierName: string; count: number }> {
    return (this.db.prepare(`
      SELECT supplier_id, supplier_name, COUNT(*) AS count
      FROM deals GROUP BY supplier_id ORDER BY count DESC LIMIT ?
    `).all(limit) as any[]).map(r => ({
      supplierId: Number(r.supplier_id), supplierName: r.supplier_name, count: Number(r.count),
    }));
  }
}

// ── AnalyticsRepository ───────────────────────────────────────────────────────

export class AnalyticsRepository {
  constructor(private db: Database.Database) { }

  push(event: AnalyticsEvent): void {
    this.db.prepare(`
      INSERT INTO analytics_events (type, product_id, supplier_id, user_id, at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.type, event.productId, event.supplierId, event.userId, event.at);
  }

  /** Returns true if the user has already generated a 'view' event for this
   *  product within the last windowMs milliseconds. */
  hasRecentEvent(userId: number, productId: string, type: AnalyticsEventType, windowMs: number): boolean {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    return !!(this.db.prepare(
      'SELECT 1 FROM analytics_events WHERE user_id=? AND product_id=? AND type=? AND at > ? LIMIT 1'
    ).get(userId, productId, type, cutoff));
  }
}

// ── Meta / migration helpers ──────────────────────────────────────────────────

export class MetaRepository {
  constructor(private db: Database.Database) { }
  get(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM _meta WHERE key=?').get(key) as any)?.value;
  }
  set(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO _meta (key,value) VALUES (?,?)').run(key, value);
  }
}

// ── SessionRepository ─────────────────────────────────────────────────────────

export interface SessionData {
  step?: string;
  tempData?: Record<string, any>;
  catalog?: {
    role: 'supplier' | 'admin';
    category: string;
    page: number;
    cursors: Array<{ createdAt: string; id: string } | null>;
  };
}

export class SessionRepository {
  constructor(private db: Database.Database) { }

  get(userId: number): SessionData {
    const row = this.db.prepare('SELECT step, temp_data FROM sessions WHERE user_id = ?').get(userId) as any;
    if (!row) return {};
    const parsed = safeJsonParse(row.temp_data, {}) as any;
    return {
      step: row.step ?? undefined,
      tempData: parsed.tempData ?? parsed,
      catalog: parsed.catalog,
    };
  }

  set(userId: number, data: SessionData): void {
    const toSave = { tempData: data.tempData, catalog: data.catalog };
    this.db.prepare(`
      INSERT INTO sessions (user_id, step, temp_data, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        step=excluded.step, temp_data=excluded.temp_data, updated_at=excluded.updated_at
    `).run(userId, data.step ?? null, JSON.stringify(toSave));
  }

  clear(userId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  /** Purge sessions older than 24 hours (abandoned flows) */
  cleanup(): void {
    this.db.prepare("DELETE FROM sessions WHERE updated_at < datetime('now', '-1 day')").run();
  }
}

// ── TransactionRepository ─────────────────────────────────────────────────────

function rowToTransaction(row: any): Transaction {
  return {
    id: row.id, mivraTxId: row.mivra_tx_id, userId: Number(row.user_id),
    productId: row.product_id ?? undefined, type: row.type as any,
    amount: Number(row.amount), status: row.status as any,
    createdAt: row.created_at, updatedAt: row.updated_at,
    performTime: row.perform_time ?? undefined,
    cancelTime: row.cancel_time ?? undefined,
  };
}

export class TransactionRepository {
  constructor(private db: Database.Database) {}

  findById(id: string): Transaction | undefined {
    const row = this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    return row ? rowToTransaction(row) : undefined;
  }

  findByMivraId(mivraTxId: string): Transaction | undefined {
    const row = this.db.prepare('SELECT * FROM transactions WHERE mivra_tx_id = ?').get(mivraTxId);
    return row ? rowToTransaction(row) : undefined;
  }

  findByDateRange(fromTime: number, toTime: number): Transaction[] {
    const fromStr = new Date(fromTime).toISOString();
    const toStr = new Date(toTime).toISOString();
    const rows = this.db.prepare('SELECT * FROM transactions WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC').all(fromStr, toStr) as any[];
    return rows.map(rowToTransaction);
  }

  create(tx: Transaction): void {
    this.db.prepare(`
      INSERT INTO transactions (id, mivra_tx_id, user_id, product_id, type, amount, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tx.id, tx.mivraTxId, tx.userId, tx.productId ?? null, tx.type, tx.amount, tx.status, tx.createdAt, tx.updatedAt);
  }

  updateStatus(id: string, status: 'pending' | 'completed' | 'cancelled'): void {
    this.db.prepare(`
      UPDATE transactions SET status = ?, updated_at = datetime('now') WHERE id = ?
    `).run(status, id);
  }

  /** Strictly-enforced state machine transition */
  transition(id: string, to: TxStatus): void {
    const tx = this.findById(id);
    if (!tx) throw new Error(`transaction ${id} not found`);
    const allowed = ALLOWED_TRANSITIONS[tx.status];
    if (!allowed.includes(to)) {
      throw new Error(`Illegal tx transition: ${tx.status} → ${to} for tx ${id}`);
    }
    this.db.prepare(`UPDATE transactions SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(to, id);
  }

  markPerformed(id: string): void {
    const tx = this.findById(id);
    if (!tx) throw new Error(`transaction ${id} not found`);
    if (tx.status !== 'pending') throw new Error(`Cannot mark performed: tx ${id} is ${tx.status}`);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE transactions SET status = 'completed', perform_time = ?, updated_at = ? WHERE id = ?
    `).run(now, now, id);
  }

  markCancelled(id: string): void {
    const tx = this.findById(id);
    if (!tx) throw new Error(`transaction ${id} not found`);
    if (tx.status === 'cancelled') return; // idempotent
    const allowed = ALLOWED_TRANSITIONS[tx.status];
    if (!allowed.includes('cancelled')) {
      throw new Error(`Cannot cancel tx ${id} from state ${tx.status}`);
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE transactions SET status = 'cancelled', cancel_time = ?, updated_at = ? WHERE id = ?
    `).run(now, now, id);
  }
}

// ── NonceRepository ──────────────────────────────────────────────────────────

export class NonceRepository {
  constructor(private db: Database.Database) {}

  /** Returns true if the nonce is fresh (not seen before) and stores it. */
  checkAndStore(nonce: string, method: string): boolean {
    const existing = this.db.prepare('SELECT nonce FROM webhook_nonces WHERE nonce = ?').get(nonce);
    if (existing) return false;
    this.db.prepare('INSERT INTO webhook_nonces (nonce, method) VALUES (?, ?)').run(nonce, method);
    return true;
  }

  /** Purge nonces older than 1 hour — call periodically */
  cleanup(): void {
    this.db.prepare("DELETE FROM webhook_nonces WHERE created_at < datetime('now', '-1 hour')").run();
  }
}

// ── RefundRepository ─────────────────────────────────────────────────────────

function rowToRefund(row: any): Refund {
  return {
    id: row.id, transactionId: row.transaction_id, adminId: Number(row.admin_id),
    reason: row.reason, amount: Number(row.amount),
    revokeService: Boolean(row.revoke_service),
    status: row.status as any,
    createdAt: row.created_at, completedAt: row.completed_at ?? undefined,
  };
}

export class RefundRepository {
  constructor(private db: Database.Database) {}

  findById(id: string): Refund | undefined {
    const row = this.db.prepare('SELECT * FROM refunds WHERE id = ?').get(id);
    return row ? rowToRefund(row) : undefined;
  }

  findByTransaction(txId: string): Refund[] {
    const rows = this.db.prepare('SELECT * FROM refunds WHERE transaction_id = ? ORDER BY created_at DESC').all(txId) as any[];
    return rows.map(rowToRefund);
  }

  findAll(limit = 50): Refund[] {
    const rows = this.db.prepare('SELECT * FROM refunds ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
    return rows.map(rowToRefund);
  }

  create(refund: Refund): void {
    this.db.prepare(`
      INSERT INTO refunds (id, transaction_id, admin_id, reason, amount, revoke_service, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(refund.id, refund.transactionId, refund.adminId, refund.reason, refund.amount, Number(refund.revokeService), refund.createdAt);
  }

  complete(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE refunds SET status = 'completed', completed_at = ? WHERE id = ?`).run(now, id);
  }

  reject(id: string): void {
    this.db.prepare(`UPDATE refunds SET status = 'rejected' WHERE id = ?`).run(id);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface Repos {
  db: Database.Database;
  users: UserRepository;
  products: ProductRepository;
  requests: RequestRepository;
  deals: DealRepository;
  analytics: AnalyticsRepository;
  meta: MetaRepository;
  sessions: SessionRepository;
  transactions: TransactionRepository;
  nonces: NonceRepository;
  refunds: RefundRepository;
}

export function createRepos(db: Database.Database): Repos {
  return {
    db,
    users: new UserRepository(db),
    products: new ProductRepository(db),
    requests: new RequestRepository(db),
    deals: new DealRepository(db),
    analytics: new AnalyticsRepository(db),
    meta: new MetaRepository(db),
    sessions: new SessionRepository(db),
    transactions: new TransactionRepository(db),
    nonces: new NonceRepository(db),
    refunds: new RefundRepository(db),
  };
}
