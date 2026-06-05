/**
 * mivra_referral.ts — Referral System (Growth Engine)
 *
 * Milestone rewards:
 *   #1:  3 valid referrals   → 1 Featured Boost (7 days, user-activated)
 *   #2: 10 valid referrals   → PRO 30 days (auto-applied, stackable)
 *   #3: 25 invited STORES    → PRO 6 months + 3 extra Boosts (suppliers only)
 *
 * Anti-abuse:
 *   - Each user can only be invited once (UNIQUE constraint on invited_id)
 *   - Self-referrals blocked at application level
 *   - Each milestone can only be earned once (UNIQUE index on user_id + type)
 *   - Referrals only become "valid" after full onboarding/approval
 *   - Re-registering the same Telegram ID never re-creates a referral
 */

import Database from 'better-sqlite3';
import { logger } from './mivra_logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Referral {
  id:          string;
  inviterId:   number;
  invitedId:   number;
  invitedRole?: string;
  status:      'pending' | 'valid';
  createdAt:   string;
  activatedAt?: string;
}

export type RewardType = 'boost_3' | 'pro_10' | 'pro_6mo_25stores';

export interface ReferralReward {
  id:        string;
  userId:    number;
  type:      RewardType;
  milestone: number;
  earnedAt:  string;
}

export interface ReferralStats {
  totalValid:   number;
  storeCount:   number;
  rewards:      ReferralReward[];
  availBoosts:  number;
}

// ── Code generator ────────────────────────────────────────────────────────────

/** Generate a short unique referral code like MIVRA_k8jf2 */
export function generateReferralCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = 'MIVRA_';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Repository ────────────────────────────────────────────────────────────────

function toReferral(row: any): Referral {
  return {
    id: row.id, inviterId: Number(row.inviter_id), invitedId: Number(row.invited_id),
    invitedRole: row.invited_role ?? undefined, status: row.status,
    createdAt: row.created_at, activatedAt: row.activated_at ?? undefined,
  };
}
function toReward(row: any): ReferralReward {
  return { id: row.id, userId: Number(row.user_id), type: row.type, milestone: Number(row.milestone), earnedAt: row.earned_at };
}

export class ReferralRepository {
  constructor(private db: Database.Database) {}

  /** Look up user by referral code (used at /start deep link) */
  findUserByCode(code: string): number | null {
    const row = this.db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code) as any;
    return row ? Number(row.id) : null;
  }

  /** Ensure a user has a referral code; generate one if missing */
  ensureCode(userId: number): string {
    const row = this.db.prepare('SELECT referral_code FROM users WHERE id = ?').get(userId) as any;
    if (row?.referral_code) return row.referral_code;
    // Generate a collision-free code
    let code: string;
    for (let attempt = 0; attempt < 10; attempt++) {
      code = generateReferralCode();
      const exists = this.db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code);
      if (!exists) break;
    }
    this.db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(code!, userId);
    return code!;
  }

  /** Record a pending referral link (invited_id is unique — safe to call once per user) */
  createPending(inviterId: number, invitedId: number): boolean {
    try {
      const id = `ref_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      this.db.prepare(`
        INSERT INTO referrals (id, inviter_id, invited_id, status)
        VALUES (?, ?, ?, 'pending')
      `).run(id, inviterId, invitedId);
      return true;
    } catch {
      return false; // invited_id UNIQUE violation → already referred, silent skip
    }
  }

  /** Mark the referral valid (called after store completes registration / supplier approved) */
  activate(invitedId: number, role: string): Referral | null {
    const row = this.db.prepare(`SELECT * FROM referrals WHERE invited_id = ? AND status = 'pending'`).get(invitedId) as any;
    if (!row) return null;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE referrals SET status = 'valid', invited_role = ?, activated_at = ? WHERE id = ?
    `).run(role, now, row.id);
    return toReferral({ ...row, status: 'valid', invited_role: role, activated_at: now });
  }

  /** Count of all valid referrals by this inviter */
  countValid(inviterId: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM referrals WHERE inviter_id = ? AND status = 'valid'`).get(inviterId) as any;
    return row?.c ?? 0;
  }

  /** Count of valid referrals where invited_role = 'store' */
  countValidStores(inviterId: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM referrals WHERE inviter_id = ? AND status = 'valid' AND invited_role = 'store'`).get(inviterId) as any;
    return row?.c ?? 0;
  }

  /** Has this invited_id already been registered via any referral? */
  isAlreadyReferred(invitedId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM referrals WHERE invited_id = ?').get(invitedId);
  }

  /** Top inviters (admin view) */
  topInviters(limit = 10): Array<{ inviterId: number; validCount: number; storCount: number }> {
    const rows = this.db.prepare(`
      SELECT inviter_id,
             COUNT(*) FILTER (WHERE status = 'valid') AS valid_count,
             COUNT(*) FILTER (WHERE status = 'valid' AND invited_role = 'store') AS store_count
      FROM referrals GROUP BY inviter_id ORDER BY valid_count DESC LIMIT ?
    `).all(limit) as any[];
    return rows.map(r => ({ inviterId: Number(r.inviter_id), validCount: Number(r.valid_count), storCount: Number(r.store_count) }));
  }
}

export class ReferralRewardRepository {
  constructor(private db: Database.Database) {}

  findByUser(userId: number): ReferralReward[] {
    const rows = this.db.prepare('SELECT * FROM referral_rewards WHERE user_id = ? ORDER BY earned_at ASC').all(userId) as any[];
    return rows.map(toReward);
  }

  hasEarned(userId: number, type: RewardType): boolean {
    return !!this.db.prepare('SELECT 1 FROM referral_rewards WHERE user_id = ? AND type = ?').get(userId, type);
  }

  record(userId: number, type: RewardType, milestone: number): boolean {
    try {
      const id = `rwr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
      this.db.prepare(`INSERT INTO referral_rewards (id, user_id, type, milestone) VALUES (?, ?, ?, ?)`).run(id, userId, type, milestone);
      return true;
    } catch {
      return false; // already earned — UNIQUE index prevents duplicate
    }
  }
}

// ── Milestone Engine ──────────────────────────────────────────────────────────

/** Called every time a referral is activated. Checks all milestones and distributes rewards. */
export function checkAndDistributeRewards(
  db: Database.Database,
  inviterId: number,
  invitedRole: string,
  refRepo: ReferralRepository,
  rewardRepo: ReferralRewardRepository,
): RewardType[] {
  const totalValid  = refRepo.countValid(inviterId);
  const storeCount  = refRepo.countValidStores(inviterId);
  const newRewards: RewardType[] = [];

  // ── Milestone 1: 3 valid referrals → 1 Boost ────────────────────────────
  if (totalValid >= 3 && !rewardRepo.hasEarned(inviterId, 'boost_3')) {
    const granted = rewardRepo.record(inviterId, 'boost_3', totalValid);
    if (granted) {
      db.prepare('UPDATE users SET available_boosts = available_boosts + 1 WHERE id = ?').run(inviterId);
      newRewards.push('boost_3');
      logger.info('REFERRAL', `Milestone boost_3 granted`, { inviterId, totalValid });
    }
  }

  // ── Milestone 2: 10 valid referrals → PRO 30 days ───────────────────────
  if (totalValid >= 10 && !rewardRepo.hasEarned(inviterId, 'pro_10')) {
    const granted = rewardRepo.record(inviterId, 'pro_10', totalValid);
    if (granted) {
      applyProDays(db, inviterId, 30);
      newRewards.push('pro_10');
      logger.info('REFERRAL', `Milestone pro_10 granted`, { inviterId, totalValid });
    }
  }

  // ── Milestone 3 (suppliers only): 25 invited stores → PRO 6 months + 3 Boosts
  if (invitedRole === 'store' && storeCount >= 25 && !rewardRepo.hasEarned(inviterId, 'pro_6mo_25stores')) {
    const inviter = db.prepare('SELECT role FROM users WHERE id = ?').get(inviterId) as any;
    if (inviter?.role === 'supplier') {
      const granted = rewardRepo.record(inviterId, 'pro_6mo_25stores', storeCount);
      if (granted) {
        applyProDays(db, inviterId, 180);
        db.prepare('UPDATE users SET available_boosts = available_boosts + 3 WHERE id = ?').run(inviterId);
        newRewards.push('pro_6mo_25stores');
        logger.info('REFERRAL', `Milestone pro_6mo_25stores granted`, { inviterId, storeCount });
      }
    }
  }

  return newRewards;
}

/** Extend PRO for userId by N days (stacks on existing active period). */
function applyProDays(db: Database.Database, userId: number, days: number): void {
  const user = db.prepare('SELECT is_pro, pro_until FROM users WHERE id = ?').get(userId) as any;
  if (!user) return;
  const base = user.pro_until && new Date(user.pro_until).getTime() > Date.now()
    ? new Date(user.pro_until)
    : new Date();
  base.setDate(base.getDate() + days);
  db.prepare('UPDATE users SET is_pro = 1, pro_until = ? WHERE id = ?').run(base.toISOString(), userId);
}

/** Build stats object for a user (for profile display) */
export function getReferralStats(
  db: Database.Database,
  userId: number,
  refRepo: ReferralRepository,
  rewardRepo: ReferralRewardRepository,
): ReferralStats {
  const totalValid  = refRepo.countValid(userId);
  const storeCount  = refRepo.countValidStores(userId);
  const rewards     = rewardRepo.findByUser(userId);
  const row = db.prepare('SELECT available_boosts FROM users WHERE id = ?').get(userId) as any;
  return { totalValid, storeCount, rewards, availBoosts: row?.available_boosts ?? 0 };
}
