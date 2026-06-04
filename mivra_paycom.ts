/**
 * mivra_paycom.ts — Paycom (Payme) Webhook Server — Production Grade
 *
 * Security layers (in order):
 *   1. Environment guard  — blocks real tokens in dev/staging
 *   2. Basic Auth         — PAYCOM_TOKEN from env, never from request
 *   3. IP Allowlist       — optional PAYCOM_ALLOWED_IPS CIDR list
 *   4. Replay protection  — timestamp window (5 min) + nonce hash dedup
 *   5. State machine      — strict transition enforcement in TransactionRepository
 *
 * Monetization products:
 *   PRO      — 42 000 UZS / 30 days — supplier ranking & product listing boost
 *   FEATURED — 10 000 UZS /  7 days — single product priority highlight
 *
 * CancelTransaction policy (completed transactions):
 *   Accounting cancellation ONLY. Service is NOT revoked automatically.
 *   Use the admin /refund command for explicit service revocation.
 */

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Repos } from './mivra_repos';
import { logger, auditPaycom } from './mivra_logger';
import dotenv from 'dotenv';
dotenv.config();

// ── Configuration ─────────────────────────────────────────────────────────────

const NODE_ENV          = process.env.NODE_ENV           ?? 'development';
const PAYCOM_TOKEN      = process.env.PAYCOM_TOKEN       ?? '';
const PAYCOM_MERCHANT_ID = process.env.PAYCOM_MERCHANT_ID ?? '';
const PAYCOM_ALLOWED_IPS = process.env.PAYCOM_ALLOWED_IPS ?? ''; // comma-separated CIDRs
const REPLAY_WINDOW_MS   = 5 * 60 * 1000;  // 5 minutes

// ── Environment Guard ─────────────────────────────────────────────────────────
// Prevent accidental production token usage in dev/staging environments.
// A live token does NOT contain 'TEST' in it.

const IS_LIVE_TOKEN = PAYCOM_TOKEN && !PAYCOM_TOKEN.includes('TEST');

if (IS_LIVE_TOKEN && NODE_ENV !== 'production') {
  logger.error('PAYCOM', 'CRITICAL: Live Paycom token detected outside production environment!', {
    NODE_ENV, hint: 'Set NODE_ENV=production or switch to a TEST token',
  });
  throw new Error(
    `[PAYCOM] Refusing to start: live token detected in NODE_ENV=${NODE_ENV}. ` +
    'Use a TEST token in development or set NODE_ENV=production.'
  );
}

if (!PAYCOM_TOKEN) {
  logger.warn('PAYCOM', 'PAYCOM_TOKEN not set — all webhook requests will be rejected');
}
if (!PAYCOM_MERCHANT_ID) {
  logger.warn('PAYCOM', 'PAYCOM_MERCHANT_ID not set — checkout URL generation disabled');
}

// ── IP Allowlist helper ───────────────────────────────────────────────────────

/**
 * Rudimentary CIDR match for IPv4.
 * Only used when PAYCOM_ALLOWED_IPS is set.
 */
function ipInCIDR(ip: string, cidr: string): boolean {
  try {
    const [network, bits] = cidr.split('/');
    const mask = bits ? ~((1 << (32 - Number(bits))) - 1) : -1;
    const ipInt  = ip.split('.').reduce((acc, o) => (acc << 8) | Number(o), 0) >>> 0;
    const netInt = network.split('.').reduce((acc, o) => (acc << 8) | Number(o), 0) >>> 0;
    return (ipInt & mask) === (netInt & mask);
  } catch { return false; }
}

const ALLOWED_CIDRS = PAYCOM_ALLOWED_IPS
  ? PAYCOM_ALLOWED_IPS.split(',').map(s => s.trim()).filter(Boolean)
  : [];

function isAllowedIp(ip: string): boolean {
  if (ALLOWED_CIDRS.length === 0) return true; // no filter configured
  return ALLOWED_CIDRS.some(cidr => ipInCIDR(ip, cidr));
}

// ── Nonce / Dedup hash ────────────────────────────────────────────────────────

/**
 * Compute a deterministic nonce from the webhook payload fields.
 * Different Paycom calls for the SAME transaction will have different
 * nonces because `method` and `time` differ.
 */
function computeNonce(method: string, paycomId: string, amount: number, time: number): string {
  return crypto
    .createHash('sha256')
    .update(`${method}:${paycomId}:${amount}:${time}`)
    .digest('hex');
}

// ── Checkout URL helper (exported) ────────────────────────────────────────────

export interface CheckoutOptions { mivraTxId: string; amountTiyins: number; }

/**
 * Generate a Paycom checkout redirect URL.
 * Returns null (+ warning) when PAYCOM_MERCHANT_ID is not configured.
 * The URL is a client-side redirect ONLY — all validation is server-side.
 */
export function buildCheckoutUrl(opts: CheckoutOptions): string | null {
  if (!PAYCOM_MERCHANT_ID) {
    logger.warn('PAYCOM', 'buildCheckoutUrl called but PAYCOM_MERCHANT_ID is not set');
    return null;
  }
  const raw = `m=${PAYCOM_MERCHANT_ID};ac.order_id=${opts.mivraTxId};a=${opts.amountTiyins}`;
  return `https://checkout.paycom.uz/${Buffer.from(raw).toString('base64')}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ms(iso: string): number { return new Date(iso).getTime(); }

function rpcError(id: any, code: number, message: string, data?: string) {
  return { id, error: { code, message: { ru: message, uz: message, en: message }, data } };
}

// ── Server factory ─────────────────────────────────────────────────────────────

export function startPaycomServer(repos: Repos, port = 3000): void {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // ── MW 1: IP Allowlist ─────────────────────────────────────────────────────
  app.use('/paycom', (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.headers['x-forwarded-for'] as string ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    if (!isAllowedIp(ip)) {
      auditPaycom({ method: 'AUTH', result: 'ip_blocked', detail: `Blocked IP: ${ip}` });
      return res.status(403).json(rpcError(null, -32504, 'Forbidden'));
    }
    next();
  });

  // ── MW 2: Basic Auth ───────────────────────────────────────────────────────
  app.use('/paycom', (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Basic ')) {
      auditPaycom({ method: req.body?.method ?? 'AUTH', result: 'auth_fail', detail: 'Missing Authorization header' });
      return res.status(401).json(rpcError(null, -32504, 'Insufficient privileges'));
    }
    const decoded  = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
    const password = decoded.substring(decoded.indexOf(':') + 1);
    if (!PAYCOM_TOKEN || password !== PAYCOM_TOKEN) {
      auditPaycom({ method: req.body?.method ?? 'AUTH', result: 'auth_fail', detail: 'Token mismatch' });
      return res.status(401).json(rpcError(null, -32504, 'Insufficient privileges'));
    }
    next();
  });

  // ── MW 3: Replay protection (time window) ──────────────────────────────────
  app.use('/paycom', (req: Request, res: Response, next: NextFunction) => {
    const requestTime: number | undefined = req.body?.time;
    if (typeof requestTime === 'number') {
      const age = Date.now() - requestTime;
      if (age > REPLAY_WINDOW_MS || age < -60_000) {
        auditPaycom({
          method: req.body?.method ?? 'UNKNOWN',
          result: 'replay',
          detail: `age=${age}ms, window=${REPLAY_WINDOW_MS}ms`,
        });
        return res.status(400).json(rpcError(req.body?.id, -32400, 'Request expired or timestamp invalid'));
      }
    }
    next();
  });

  // ── MW 4: Nonce dedup ──────────────────────────────────────────────────────
  // Only deduplicate calls that carry paycomId + amount + time (idempotency
  // for calls without these fields is handled at the method level).
  app.use('/paycom', (req: Request, res: Response, next: NextFunction) => {
    const { method, params } = req.body ?? {};
    const paycomId = params?.id;
    const amount   = params?.amount;
    const reqTime  = req.body?.time;

    if (method && paycomId && typeof amount === 'number' && typeof reqTime === 'number') {
      const nonce = computeNonce(method, paycomId, amount, reqTime);
      const fresh = repos.nonces.checkAndStore(nonce, method);
      if (!fresh) {
        auditPaycom({ method, paycomId, result: 'nonce_dup', detail: `Duplicate nonce ${nonce.slice(0, 8)}…` });
        // Return the current transaction state instead of an error
        // so Paycom doesn't retry infinitely
        const tx = repos.transactions.findById(paycomId);
        if (tx) {
          const state = tx.status === 'pending' ? 1 : tx.status === 'completed' ? 2 : (tx.performTime ? -2 : -1);
          return res.json({ id: req.body?.id, result: { transaction: tx.id, state } });
        }
        return res.json(rpcError(req.body?.id, -32400, 'Duplicate request'));
      }
    }
    next();
  });

  // ── RPC Handler ───────────────────────────────────────────────────────────
  app.post('/paycom', (req: Request, res: Response) => {
    const { method, params, id } = req.body;

    function fail(code: number, message: string, data?: string, detail?: string) {
      auditPaycom({ method, paycomId: params?.id, mivraTxId: params?.account?.order_id, result: 'error', detail: detail ?? message });
      return res.json(rpcError(id, code, message, data));
    }

    if (method !== 'GetStatement' && !params?.account?.order_id) {
      return fail(-31050, 'Order not found', 'order_id');
    }

    const mivraTxId: string | undefined = params?.account?.order_id;
    const amount:    number | undefined  = params?.amount;
    const paycomId:  string | undefined  = params?.id;

    switch (method) {

      // ── CheckPerformTransaction ──────────────────────────────────────────
      case 'CheckPerformTransaction': {
        const tx = repos.transactions.findByMivraId(mivraTxId!);
        if (!tx)                       return fail(-31050, 'Order not found', 'order_id');
        if (tx.amount !== amount)      return fail(-31001, 'Incorrect amount', undefined, `expected=${tx.amount} got=${amount}`);
        if (tx.status === 'cancelled') return fail(-31008, 'Order cancelled');
        if (tx.status === 'completed') return fail(-31008, 'Order already completed');
        auditPaycom({ method, mivraTxId, userId: tx.userId, type: tx.type, amount: tx.amount, result: 'ok' });
        return res.json({ id, result: { allow: true } });
      }

      // ── CreateTransaction ────────────────────────────────────────────────
      case 'CreateTransaction': {
        const existing = repos.transactions.findById(paycomId!);
        if (existing) {
          auditPaycom({ method, paycomId, mivraTxId, userId: existing.userId, type: existing.type, amount: existing.amount, fromStatus: existing.status, toStatus: existing.status, result: 'ok', detail: 'idempotent replay' });
          if (existing.status === 'cancelled') return res.json({ id, result: { create_time: ms(existing.createdAt), cancel_time: ms(existing.cancelTime ?? existing.updatedAt), transaction: existing.id, state: -1 } });
          if (existing.status === 'completed') return res.json({ id, result: { create_time: ms(existing.createdAt), perform_time: ms(existing.performTime ?? existing.updatedAt), transaction: existing.id, state: 2 } });
          return res.json({ id, result: { create_time: ms(existing.createdAt), transaction: existing.id, state: 1 } });
        }
        const tx = repos.transactions.findByMivraId(mivraTxId!);
        if (!tx)                       return fail(-31050, 'Order not found', 'order_id');
        if (tx.amount !== amount)      return fail(-31001, 'Incorrect amount');
        if (tx.status === 'cancelled') return fail(-31008, 'Order cancelled');
        if (tx.status === 'completed') return fail(-31008, 'Order already performed');
        const isLinked = tx.id && !tx.id.endsWith('_tmp') && tx.id !== paycomId;
        if (isLinked) return fail(-31050, 'Order already in payment process', 'order_id');
        const now = new Date().toISOString();
        repos.db.prepare('UPDATE transactions SET id = ?, updated_at = ? WHERE mivra_tx_id = ?').run(paycomId, now, mivraTxId);
        auditPaycom({ method, paycomId, mivraTxId, userId: tx.userId, type: tx.type, amount: tx.amount, fromStatus: 'pending', toStatus: 'pending', result: 'ok', detail: 'linked to Paycom ID' });
        return res.json({ id, result: { create_time: ms(now), transaction: paycomId, state: 1 } });
      }

      // ── PerformTransaction ───────────────────────────────────────────────
      case 'PerformTransaction': {
        const tx = repos.transactions.findById(paycomId!);
        if (!tx) return fail(-31003, 'Transaction not found');

        if (tx.status === 'completed') {
          auditPaycom({ method, paycomId, userId: tx.userId, type: tx.type, amount: tx.amount, fromStatus: 'completed', toStatus: 'completed', result: 'ok', detail: 'idempotent replay' });
          return res.json({ id, result: { transaction: tx.id, perform_time: ms(tx.performTime ?? tx.updatedAt), state: 2 } });
        }
        if (tx.status === 'cancelled') return fail(-31008, 'Cannot perform — transaction cancelled');

        // Activate service (exactly once — markPerformed throws if not pending)
        try {
          if (tx.type === 'PRO') {
            const user = repos.users.findById(tx.userId);
            if (user) {
              user.isPro = true;
              const base = user.proUntil && new Date(user.proUntil).getTime() > Date.now() ? new Date(user.proUntil) : new Date();
              base.setDate(base.getDate() + 30);
              user.proUntil = base.toISOString();
              repos.users.save(user);
            }
          } else if (tx.type === 'FEATURED' && tx.productId) {
            const product = repos.products.findById(tx.productId);
            if (product) {
              product.isFeatured = true;
              const base = product.featuredUntil && new Date(product.featuredUntil).getTime() > Date.now() ? new Date(product.featuredUntil) : new Date();
              base.setDate(base.getDate() + 7);
              product.featuredUntil = base.toISOString();
              repos.products.save(product);
            }
          }
          repos.transactions.markPerformed(tx.id);
        } catch (e: any) {
          logger.error('PAYCOM', 'PerformTransaction activation error', { paycomId, error: e.message });
          return fail(-31008, 'Transaction processing error');
        }

        const performed = repos.transactions.findById(tx.id)!;
        auditPaycom({ method, paycomId, userId: tx.userId, productId: tx.productId, type: tx.type, amount: tx.amount, fromStatus: 'pending', toStatus: 'completed', result: 'ok' });
        return res.json({ id, result: { transaction: tx.id, perform_time: ms(performed.performTime ?? performed.updatedAt), state: 2 } });
      }

      // ── CheckTransaction ─────────────────────────────────────────────────
      case 'CheckTransaction': {
        const tx = repos.transactions.findById(paycomId!);
        if (!tx) return fail(-31003, 'Transaction not found');
        const state = tx.status === 'pending' ? 1 : tx.status === 'completed' ? 2 : (tx.performTime ? -2 : -1);
        auditPaycom({ method, paycomId, userId: tx.userId, type: tx.type, amount: tx.amount, fromStatus: tx.status, result: 'ok' });
        return res.json({ id, result: {
          create_time:  ms(tx.createdAt),
          perform_time: tx.performTime ? ms(tx.performTime) : 0,
          cancel_time:  tx.cancelTime  ? ms(tx.cancelTime)  : 0,
          transaction:  tx.id, state,
          reason: tx.status === 'cancelled' ? 1 : null,
        }});
      }

      // ── CancelTransaction ────────────────────────────────────────────────
      //
      // POLICY: Completed transactions → accounting cancellation ONLY.
      // Service is NOT revoked. Use admin /refund for explicit revocation.
      case 'CancelTransaction': {
        const tx = repos.transactions.findById(paycomId!);
        if (!tx) return fail(-31003, 'Transaction not found');

        if (tx.status === 'cancelled') {
          const state = tx.performTime ? -2 : -1;
          auditPaycom({ method, paycomId, userId: tx.userId, type: tx.type, amount: tx.amount, fromStatus: 'cancelled', toStatus: 'cancelled', result: 'ok', detail: 'idempotent replay' });
          return res.json({ id, result: { transaction: tx.id, cancel_time: ms(tx.cancelTime ?? tx.updatedAt), state } });
        }

        let state: number;
        try {
          repos.transactions.markCancelled(tx.id);
        } catch (e: any) {
          return fail(-31008, 'Cannot cancel this transaction', undefined, e.message);
        }

        if (tx.status === 'pending') {
          state = -1;
          auditPaycom({ method, paycomId, userId: tx.userId, type: tx.type, amount: tx.amount, fromStatus: 'pending', toStatus: 'cancelled', result: 'ok' });
        } else {
          // completed → accounting cancel, no service rollback
          state = -2;
          auditPaycom({ method, paycomId, userId: tx.userId, productId: tx.productId, type: tx.type, amount: tx.amount, fromStatus: 'completed', toStatus: 'cancelled', result: 'ok', detail: 'Accounting cancel — service preserved. Manual refund required.' });
          logger.warn('PAYCOM', `CancelTransaction on completed tx — manual review required`, { paycomId, userId: tx.userId, type: tx.type, amount: tx.amount });
        }

        const cancelled = repos.transactions.findById(tx.id)!;
        return res.json({ id, result: { transaction: tx.id, cancel_time: ms(cancelled.cancelTime ?? cancelled.updatedAt), state } });
      }

      // ── GetStatement ─────────────────────────────────────────────────────
      case 'GetStatement': {
        const { from, to } = params ?? {};
        if (typeof from !== 'number' || typeof to !== 'number') return fail(-32700, 'from and to must be Unix ms timestamps');
        if (from > to) return fail(-32700, 'from must be <= to');
        const txs = repos.transactions.findByDateRange(from, to);
        auditPaycom({ method, result: 'ok', detail: `from=${from} to=${to} count=${txs.length}` });
        return res.json({ id, result: { transactions: txs.map(tx => ({
          id: tx.id, time: ms(tx.createdAt), amount: tx.amount,
          account: { order_id: tx.mivraTxId },
          create_time:  ms(tx.createdAt),
          perform_time: tx.performTime ? ms(tx.performTime) : 0,
          cancel_time:  tx.cancelTime  ? ms(tx.cancelTime)  : 0,
          transaction:  tx.id,
          state:        tx.status === 'pending' ? 1 : tx.status === 'completed' ? 2 : (tx.performTime ? -2 : -1),
          reason:       tx.status === 'cancelled' ? 1 : null,
        })) } });
      }

      default:
        return fail(-32601, 'Method not found', undefined, `Unknown: ${method}`);
    }
  });

  app.listen(port, () => {
    logger.info('PAYCOM', `Webhook server listening on :${port}`, { NODE_ENV, ipFilter: ALLOWED_CIDRS.length > 0 });
    if (!PAYCOM_MERCHANT_ID) logger.warn('PAYCOM', 'Checkout URL generation DISABLED — set PAYCOM_MERCHANT_ID');
  });
}
