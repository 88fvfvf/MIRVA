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
  id:           string;
  inviterId:    number;
  invitedId:    number;
  invitedRole?: string;
  status:       'pending' | 'valid';
  createdAt:    string;
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

/** Lightweight item for history view */
export interface ReferralHistoryItem {
  invitedRole?: string;
  status:       'pending' | 'valid';
  date:         string; // createdAt
}

/** Enriched stats for the analytics dashboard */
export interface ReferralFullStats {
  totalValid:       number;
  totalPending:     number;
  storeCount:       number;
  supplierCount:    number;
  rewardsEarned:    number;
  availBoosts:      number;
  isPro:            boolean;
  proUntil?:        string;
  rewards:          ReferralReward[];
  // Milestone progress
  m1Done:           boolean; // boost_3 earned
  m2Done:           boolean; // pro_10 earned
  m3Done:           boolean; // pro_6mo_25stores earned
}

/** Legacy slim stats (kept for backward-compat) */
export interface ReferralStats {
  totalValid:  number;
  storeCount:  number;
  rewards:     ReferralReward[];
  availBoosts: number;
}

/** One row in the public leaderboard */
export interface LeaderboardEntry {
  rank:       number;
  displayName: string;
  validCount:  number;
}

/** User's position in the global ranking */
export interface RankInfo {
  rank:           number;
  validCount:     number;
  nextRank:       number | null;
  nextCount:      number | null; // referrals needed for nextRank
}

// ── Achievement badges (visual only, no reward logic) ─────────────────────────

export interface Achievement {
  emoji:  string;
  nameRu: string;
  nameUz: string;
  target: number;
}

export const ACHIEVEMENTS: Achievement[] = [
  { emoji: '🥉', nameRu: 'Бронзовый реферер',  nameUz: 'Bronza referer',   target: 3  },
  { emoji: '🥈', nameRu: 'Серебряный реферер', nameUz: 'Kumush referer',   target: 10 },
  { emoji: '🥇', nameRu: 'Золотой реферер',    nameUz: 'Oltin referer',    target: 25 },
  { emoji: '💎', nameRu: 'Амбассадор MIVRA',   nameUz: 'MIVRA elchisi',    target: 50 },
];

/** Return all earned achievements for a user given their valid referral count */
export function getEarnedAchievements(totalValid: number): Achievement[] {
  return ACHIEVEMENTS.filter(a => totalValid >= a.target);
}

/** Return the next unearned achievement (or null if all earned) */
export function getNextAchievement(totalValid: number): Achievement | null {
  return ACHIEVEMENTS.find(a => totalValid < a.target) ?? null;
}

// ── Code generator ────────────────────────────────────────────────────────────

/** Generate a short unique referral code like MIVRA_k8jf2 */
export function generateReferralCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = 'MIVRA_';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Mappers ───────────────────────────────────────────────────────────────────

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

// ── ReferralRepository ────────────────────────────────────────────────────────

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
    let code: string = 'MIVRA_xxxxx';
    for (let attempt = 0; attempt < 10; attempt++) {
      code = generateReferralCode();
      const exists = this.db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code);
      if (!exists) break;
    }
    this.db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(code, userId);
    return code;
  }

  /** Record a pending referral (invited_id UNIQUE — safe to call once per user) */
  createPending(inviterId: number, invitedId: number): boolean {
    try {
      const id = `ref_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      this.db.prepare(`
        INSERT INTO referrals (id, inviter_id, invited_id, status)
        VALUES (?, ?, ?, 'pending')
      `).run(id, inviterId, invitedId);
      return true;
    } catch {
      return false;
    }
  }

  /** Mark the referral valid (called after store registration / supplier approval) */
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

  // ── Analytics Dashboard ─────────────────────────────────────────────────────

  /** Full stats for the analytics dashboard — single efficient query */
  getFullStats(inviterId: number, rewardRepo: ReferralRewardRepository): ReferralFullStats {
    // Referral counts in one query
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'valid')                            AS total_valid,
        COUNT(*) FILTER (WHERE status = 'pending')                          AS total_pending,
        COUNT(*) FILTER (WHERE status = 'valid' AND invited_role = 'store') AS store_count,
        COUNT(*) FILTER (WHERE status = 'valid' AND invited_role = 'supplier') AS sup_count
      FROM referrals WHERE inviter_id = ?
    `).get(inviterId) as any;

    // User row for PRO + boosts
    const userRow = this.db.prepare('SELECT is_pro, pro_until, available_boosts FROM users WHERE id = ?').get(inviterId) as any;

    // Earned rewards
    const rewards = rewardRepo.findByUser(inviterId);
    const m1Done = rewards.some(r => r.type === 'boost_3');
    const m2Done = rewards.some(r => r.type === 'pro_10');
    const m3Done = rewards.some(r => r.type === 'pro_6mo_25stores');

    return {
      totalValid:    Number(counts?.total_valid ?? 0),
      totalPending:  Number(counts?.total_pending ?? 0),
      storeCount:    Number(counts?.store_count ?? 0),
      supplierCount: Number(counts?.sup_count ?? 0),
      rewardsEarned: rewards.length,
      availBoosts:   Number(userRow?.available_boosts ?? 0),
      isPro:         !!(userRow?.is_pro),
      proUntil:      userRow?.pro_until ?? undefined,
      rewards,
      m1Done,
      m2Done,
      m3Done,
    };
  }

  // ── Referral History ────────────────────────────────────────────────────────

  /** Last N referrals (both pending and valid) for this inviter, newest first */
  getHistory(inviterId: number, limit = 10): ReferralHistoryItem[] {
    const rows = this.db.prepare(`
      SELECT invited_role, status, created_at
      FROM referrals WHERE inviter_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(inviterId, limit) as any[];
    return rows.map(r => ({
      invitedRole: r.invited_role ?? undefined,
      status: r.status as 'pending' | 'valid',
      date: r.created_at,
    }));
  }

  // ── Leaderboard ─────────────────────────────────────────────────────────────

  /**
   * Top N inviters by valid referral count.
   * Uses aggregation query — no full table scan.
   * Returns display names only (no IDs, no phones).
   */
  getLeaderboard(limit = 10): LeaderboardEntry[] {
    const rows = this.db.prepare(`
      SELECT r.inviter_id,
             COUNT(*) FILTER (WHERE r.status = 'valid') AS valid_count
      FROM referrals r
      GROUP BY r.inviter_id
      HAVING valid_count > 0
      ORDER BY valid_count DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map((row, i) => {
      const userId = Number(row.inviter_id);
      const uRow = this.db.prepare('SELECT role, company_name, store_name, first_name FROM users WHERE id = ?').get(userId) as any;
      const displayName = uRow?.company_name ?? uRow?.store_name ?? uRow?.first_name ?? `Пользователь #${i + 1}`;
      return {
        rank:        i + 1,
        displayName: String(displayName).slice(0, 40),
        validCount:  Number(row.valid_count),
      };
    });
  }

  // ── Personal Ranking ────────────────────────────────────────────────────────

  /**
   * Returns this user's rank and the next ranked user's count.
   * Uses a subquery instead of loading all rows into memory.
   */
  getUserRank(userId: number): RankInfo {
    // Count users who have more valid referrals than me (= my rank - 1)
    const myCount = this.countValid(userId);

    const aboveMe = this.db.prepare(`
      SELECT COUNT(DISTINCT inviter_id) AS c
      FROM referrals
      WHERE status = 'valid'
      GROUP BY inviter_id
      HAVING COUNT(*) > ?
    `).all(myCount) as any[];

    const rank = aboveMe.length + 1;

    // Find the next person ahead of me (fewest count > myCount)
    const nextRow = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM referrals
      WHERE status = 'valid'
      GROUP BY inviter_id
      HAVING COUNT(*) > ?
      ORDER BY cnt ASC
      LIMIT 1
    `).get(myCount) as any;

    return {
      rank,
      validCount:  myCount,
      nextRank:    nextRow ? rank - 1 : null,
      nextCount:   nextRow ? Number(nextRow.cnt) - myCount : null,
    };
  }

  /** Top inviters for admin view */
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

// ── ReferralRewardRepository ──────────────────────────────────────────────────

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
      return false;
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
  const totalValid = refRepo.countValid(inviterId);
  const storeCount = refRepo.countValidStores(inviterId);
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

/** Build slim stats object (backward compatibility) */
export function getReferralStats(
  db: Database.Database,
  userId: number,
  refRepo: ReferralRepository,
  rewardRepo: ReferralRewardRepository,
): ReferralStats {
  const totalValid = refRepo.countValid(userId);
  const storeCount = refRepo.countValidStores(userId);
  const rewards    = rewardRepo.findByUser(userId);
  const row = db.prepare('SELECT available_boosts FROM users WHERE id = ?').get(userId) as any;
  return { totalValid, storeCount, rewards, availBoosts: row?.available_boosts ?? 0 };
}
