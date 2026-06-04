/**
 * mivra_migrate.ts — data.json → SQLite Migration
 *
 * Strategy:
 *  1. On startup, check _meta.json_migrated flag.
 *  2. If not set: read data.json, import everything in a single transaction.
 *  3. Set the flag so it never runs again.
 *  4. The original data.json is untouched (safety backup).
 *
 * Call runMigration(db) once, right after getDb() + initSchema().
 *
 * Migration is idempotent: safe to call multiple times thanks to
 * INSERT OR IGNORE / INSERT OR REPLACE.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { createRepos, MetaRepository } from './mivra_repos';
import type {
  User, RegularUser, StoreUser, SupplierUser,
  Product, Request, Offer, DealRecord, AnalyticsEvent,
  OfferStatus, ReqStatus, AnalyticsEventType, Lang, SupplierTier,
} from './mivra_repos';

// ── Normalisation helpers (mirrors original bot's normXxx functions) ──────────

const isRec = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null;

const normL = (v: unknown): Lang => v === 'uz' ? 'uz' : 'ru';
const genId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const VALID_REQ: ReqStatus[] = ['active','offer_received','accepted','delivered','completed','cancelled'];
const VALID_AE:  AnalyticsEventType[] = ['view','contact','offer','deal'];

function normUser(raw: unknown, k: string): User | undefined {
  if (!isRec(raw)) return undefined;
  const id = Number(raw.id ?? k);
  if (!Number.isFinite(id)) return undefined;
  const base = {
    id, firstName: String(raw.firstName ?? ''),
    username: raw.username ? String(raw.username) : undefined,
    lang: normL(raw.lang),
    registeredAt: String(raw.registeredAt ?? new Date().toISOString()),
  };
  const role = raw.role === 'dealer' ? 'supplier' : raw.role;
  if (role === 'store') return {
    ...base, role: 'store',
    storeName: String(raw.storeName ?? raw.companyName ?? 'Без названия'),
    phone: String(raw.phone ?? ''), city: String(raw.city ?? ''),
    favorites: Array.isArray(raw.favorites) ? raw.favorites.map(String).filter(Boolean) : [],
  };
  if (role === 'supplier') return {
    ...base, role: 'supplier',
    companyName: String(raw.companyName ?? raw.storeName ?? 'Без названия'),
    contactPerson: String(raw.contactPerson ?? base.firstName),
    phone: String(raw.phone ?? ''), city: String(raw.city ?? ''),
    businessDescription: String(raw.businessDescription ?? ''),
    approved: Boolean(raw.approved), suspended: Boolean(raw.suspended),
    categories: Array.isArray(raw.categories)
      ? raw.categories.map(String).filter(Boolean) : [],
    tier: (['free','premium','enterprise'].includes(raw.tier)
      ? raw.tier : 'free') as SupplierTier,
  };
  if (role === 'user') return { ...base, role: 'user' };
  return undefined;
}

function normOffer(r: unknown): Offer | undefined {
  if (!isRec(r) || !Number.isFinite(Number(r.supplierId))) return undefined;
  const st = r.status as string;
  return {
    id: String(r.id ?? genId()), supplierId: Number(r.supplierId),
    supplierName: String(r.supplierName ?? ''),
    supplierPhone: String(r.supplierPhone ?? ''),
    supplierUsername: r.supplierUsername ? String(r.supplierUsername) : undefined,
    price: String(r.price ?? ''),
    deliveryAvailable: Boolean(r.deliveryAvailable),
    priceNegotiable: Boolean(r.priceNegotiable),
    estimatedDelivery: String(r.estimatedDelivery ?? ''),
    comment: String(r.comment ?? ''),
    status: (st === 'accepted' || st === 'rejected' ? st : 'pending') as OfferStatus,
    createdAt: String(r.createdAt ?? new Date().toISOString()),
  };
}

function normReq(r: unknown): Request | undefined {
  if (!isRec(r) || !Number.isFinite(Number(r.storeId))) return undefined;
  const hist = Array.isArray(r.statusHistory)
    ? r.statusHistory.filter(e => isRec(e) && VALID_REQ.includes((e as any).status))
        .map(e => ({ status: (e as any).status as ReqStatus, at: String((e as any).at ?? '') }))
    : [];
  return {
    id: String(r.id ?? genId()), storeId: Number(r.storeId),
    storeName: String(r.storeName ?? ''),
    storePhone: String(r.storePhone ?? r.phone ?? ''),
    storeUsername: r.storeUsername ? String(r.storeUsername) : undefined,
    product: String(r.product ?? ''), category: String(r.category ?? ''),
    specification: String(r.specification ?? ''), quantity: String(r.quantity ?? ''),
    unitType: String(r.unitType ?? ''), city: String(r.city ?? ''),
    deliveryAddress: String(r.deliveryAddress ?? ''),
    requiredDate: String(r.requiredDate ?? ''),
    additionalNotes: String(r.additionalNotes ?? ''),
    createdAt: String(r.createdAt ?? new Date().toISOString()),
    status: VALID_REQ.includes(r.status) ? r.status as ReqStatus : 'active',
    offers: Array.isArray(r.offers)
      ? r.offers.map(normOffer).filter(Boolean) as Offer[] : [],
    acceptedOfferId: r.acceptedOfferId ? String(r.acceptedOfferId) : undefined,
    statusHistory: hist,
  };
}

function normProduct(r: unknown): Product | undefined {
  if (!isRec(r) || !Number.isFinite(Number(r.supplierId))) return undefined;
  const photos = Array.isArray(r.photos)
    ? r.photos.map(String).filter(Boolean).slice(0, 5)
    : r.image ? [String(r.image)] : [];
  return {
    id: String(r.id ?? genId()), supplierId: Number(r.supplierId),
    supplierName: String(r.supplierName ?? ''),
    supplierPhone: String(r.supplierPhone ?? ''),
    supplierUsername: r.supplierUsername ? String(r.supplierUsername) : undefined,
    name: String(r.name ?? ''), category: String(r.category ?? ''),
    description: String(r.description ?? ''),
    weightVolume: String(r.weightVolume ?? ''),
    unitsPerBox: String(r.unitsPerBox ?? ''),
    minOrderQty: String(r.minOrderQty ?? ''),
    price: String(r.price ?? ''),
    priceNegotiable: Boolean(r.priceNegotiable),
    deliveryAvailable: Boolean(r.deliveryAvailable),
    city: String(r.city ?? ''), availabilityStatus: String(r.availabilityStatus ?? ''),
    photos, viewCount: Number(r.viewCount ?? 0),
    createdAt: String(r.createdAt ?? new Date().toISOString()),
    archived: Boolean(r.archived),
    contactClicks: Number(r.contactClicks ?? 0),
    offerResponses: Number(r.offerResponses ?? 0),
    completedDeals: Number(r.completedDeals ?? 0),
    deliveryScope: String(r.deliveryScope ?? r.delivery_scope ?? 'regional'),
  };
}

function normDeal(r: unknown): DealRecord | undefined {
  if (!isRec(r)) return undefined;
  return {
    id: String(r.id ?? genId()), requestId: String(r.requestId ?? ''),
    storeName: String(r.storeName ?? ''), storeId: Number(r.storeId ?? 0),
    supplierName: String(r.supplierName ?? ''), supplierId: Number(r.supplierId ?? 0),
    product: String(r.product ?? ''), quantity: String(r.quantity ?? ''),
    unitType: String(r.unitType ?? ''), price: String(r.price ?? ''),
    completedAt: String(r.completedAt ?? new Date().toISOString()),
    productId: r.productId ? String(r.productId) : undefined,
  };
}

function normAE(r: unknown): AnalyticsEvent | undefined {
  if (!isRec(r) || !VALID_AE.includes(r.type as any)) return undefined;
  return {
    type: r.type as AnalyticsEventType, productId: String(r.productId ?? ''),
    supplierId: Number(r.supplierId ?? 0), userId: Number(r.userId ?? 0),
    at: String(r.at ?? new Date().toISOString()),
  };
}

// ── Main migration function ───────────────────────────────────────────────────

export function runMigration(db: Database.Database, jsonPath?: string): void {
  const meta = new MetaRepository(db);

  // Already migrated → skip
  if (meta.get('json_migrated') === '1') {
    console.log('[MIVRA] SQLite DB ready (data.json already migrated).');
    return;
  }

  const dataPath = jsonPath ?? path.join(process.cwd(), 'data.json');

  // No data.json → nothing to migrate (fresh install)
  if (!fs.existsSync(dataPath)) {
    meta.set('json_migrated', '1');
    meta.set('migrated_at', new Date().toISOString());
    console.log('[MIVRA] Fresh install — no data.json found, SQLite ready.');
    return;
  }

  console.log('[MIVRA] Starting migration from data.json …');

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  } catch (e) {
    console.error('[MIVRA] Failed to parse data.json:', (e as Error).message);
    throw e;
  }

  const repos = createRepos(db);

  // Wrap everything in a single transaction: all-or-nothing
  const migrate = db.transaction(() => {

    // 1. Users
    let userCount = 0;
    if (isRec(raw.users)) {
      for (const [k, v] of Object.entries(raw.users)) {
        const user = normUser(v, k);
        if (user) { repos.users.save(user); userCount++; }
      }
    }
    console.log(`[MIVRA]   Users: ${userCount}`);

    // 2. Products
    const products = Array.isArray(raw.products)
      ? raw.products.map(normProduct).filter(Boolean) as Product[]
      : [];
    for (const p of products) repos.products.save(p);
    console.log(`[MIVRA]   Products: ${products.length}`);

    // 3. Requests + embedded offers
    const requests = Array.isArray(raw.requests)
      ? raw.requests.map(normReq).filter(Boolean) as Request[]
      : [];
    for (const r of requests) repos.requests.save(r);
    console.log(`[MIVRA]   Requests: ${requests.length}, Offers: ${requests.reduce((n, r) => n + r.offers.length, 0)}`);

    // 4. Deals
    const deals = Array.isArray(raw.deals)
      ? raw.deals.map(normDeal).filter(Boolean) as DealRecord[]
      : [];
    for (const d of deals) repos.deals.save(d);
    console.log(`[MIVRA]   Deals: ${deals.length}`);

    // 5. Analytics events (keep up to last 10k)
    const events = Array.isArray(raw.analyticsEvents)
      ? (raw.analyticsEvents.map(normAE).filter(Boolean) as AnalyticsEvent[]).slice(-10_000)
      : [];
    for (const e of events) repos.analytics.push(e);
    console.log(`[MIVRA]   Analytics events: ${events.length}`);

    // 6. Mark as done
    meta.set('json_migrated', '1');
    meta.set('migrated_at', new Date().toISOString());
    meta.set('json_source', dataPath);
    meta.set('migrated_users', String(userCount));
    meta.set('migrated_products', String(products.length));
    meta.set('migrated_requests', String(requests.length));
    meta.set('migrated_deals', String(deals.length));
  });

  migrate();

  // Keep data.json as a backup (rename, not delete)
  const backup = `${dataPath}.bak_${Date.now()}`;
  fs.copyFileSync(dataPath, backup);
  console.log(`[MIVRA] Migration complete! Backup saved: ${backup}`);
}
