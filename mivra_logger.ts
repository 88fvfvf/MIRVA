/**
 * mivra_logger.ts — Structured Production Logger
 *
 * All log lines are newline-delimited JSON (NDJSON) — easy to ship to
 * any log aggregator (Datadog, Logtail, ELK, etc.).
 *
 * Levels: debug < info < warn < error
 *
 * In production (NODE_ENV=production) debug lines are suppressed.
 * File logging is always active when LOG_FILE is set in env.
 */

import fs from 'fs';
import path from 'path';

// ── Configuration ─────────────────────────────────────────────────────────────

const ENV       = process.env.NODE_ENV  ?? 'development';
const LOG_FILE  = process.env.LOG_FILE  ?? '';   // e.g. './logs/mivra.log'
const LOG_LEVEL = process.env.LOG_LEVEL ?? (ENV === 'production' ? 'info' : 'debug');

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = LEVELS[LOG_LEVEL] ?? 1;

// ── File stream (optional) ─────────────────────────────────────────────────────

let fileStream: fs.WriteStream | null = null;
if (LOG_FILE) {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
}

// ── Core write ────────────────────────────────────────────────────────────────

function write(level: string, category: string, message: string, data?: Record<string, unknown>): void {
  if ((LEVELS[level] ?? 0) < minLevel) return;

  const entry = JSON.stringify({
    ts:  new Date().toISOString(),
    env: ENV,
    level,
    category,
    message,
    ...data,
  });

  // Console: stderr for warn/error so it's separate from stdout metrics
  if (level === 'warn' || level === 'error') {
    process.stderr.write(entry + '\n');
  } else {
    process.stdout.write(entry + '\n');
  }

  // File: always write all levels
  if (fileStream) {
    fileStream.write(entry + '\n');
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export const logger = {
  debug: (category: string, message: string, data?: Record<string, unknown>) =>
    write('debug', category, message, data),

  info: (category: string, message: string, data?: Record<string, unknown>) =>
    write('info', category, message, data),

  warn: (category: string, message: string, data?: Record<string, unknown>) =>
    write('warn', category, message, data),

  error: (category: string, message: string, data?: Record<string, unknown>) =>
    write('error', category, message, data),
};

// ── Paycom Audit ──────────────────────────────────────────────────────────────

export interface PaycomAuditEntry {
  method:      string;
  paycomId?:   string;
  mivraTxId?:  string;
  userId?:     number;
  productId?:  string;
  type?:       string;
  amount?:     number;
  fromStatus?: string;
  toStatus?:   string;
  result:      'ok' | 'error' | 'replay' | 'auth_fail' | 'nonce_dup' | 'ip_blocked';
  detail?:     string;
}

export function auditPaycom(entry: PaycomAuditEntry): void {
  write(
    entry.result === 'ok' ? 'info' : 'warn',
    'PAYCOM',
    `${entry.method} → ${entry.result}`,
    entry as unknown as Record<string, unknown>,
  );
}
