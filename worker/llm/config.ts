/**
 * worker/llm/config.ts
 *
 * Every tunable number lives here. The prompt template reads from this —
 * do not hardcode figures into the prompt text.
 *
 * Commercial figures (rate floors, threshold) are read from the environment with
 * NO committed defaults. This repo is public. See CLAUDE-CODE-INSTRUCTIONS.md 2.3.
 */

import { requireNumber } from '../lib/env.js';

/**
 * Commercial figures. Read from the environment, memoised, and deliberately NOT
 * evaluated at import time — plenty of modules import this file only for the flag
 * and case-study lists, and they should not need a rate floor to load. Stages that
 * do use these call assertCommercialEnv() first so they fail before doing work
 * rather than halfway through a batch.
 */
export type Commercial = {
  rateFloorHourlyUSD: number;
  rateFloorMonthlyUSD: number;
  /** Below this a listing is skipped. Start at 75; drop toward 65 once trusted. */
  scoreThreshold: number;
};

let commercialCache: Commercial | undefined;

export function commercial(): Commercial {
  if (commercialCache) return commercialCache;
  commercialCache = {
    rateFloorHourlyUSD: requireNumber(
      'RATE_FLOOR_HOURLY_USD',
      'Drives the below_rate flag. Without it the scorer cannot judge compensation.',
    ),
    rateFloorMonthlyUSD: requireNumber(
      'RATE_FLOOR_MONTHLY_USD',
      'Drives the below_rate flag for full-time-shaped roles.',
    ),
    scoreThreshold: requireNumber(
      'SCORE_THRESHOLD',
      'Below this a listing is skipped. Start at 75.',
    ),
  };
  return commercialCache;
}

/** Call at the top of any stage that scores or sends. */
export function assertCommercialEnv(): void {
  commercial();
}

export const SCORING_CONFIG = {
  autoTierThreshold: 85, // >= this and resolved apply path = send without review

  // --- Availability ---
  hoursPerWeek: 30,
  earliestStartWeeks: 2,
  contractTypes: ['contract', 'part-time', 'full-time'] as const,
  preferredContractTypes: ['contract', 'part-time'] as const,

  // --- Location ---
  location: 'Lagos, Nigeria',
  timezone: 'WAT (UTC+1)',
  usEasternOverlapHours: 5,
  europeOverlap: 'full',

  // --- Batch ---
  listingsPerCall: 10,

  // The scoring model is NOT set here. It lives in provider.ts, chosen by
  // SCORER_PROVIDER, because the choice carries a provider-specific JSON contract
  // with it and a bare model string here would be half the decision.
} as const;

export const HARD_ZEROS = [
  'region_restricted',      // work eligibility excludes Nigeria / Africa
  'onsite_or_hybrid',       // any required physical presence
  'unpaid_or_exposure',
  'equity_only',
  'takehome_over_4h',
] as const;

export const RED_FLAGS = [
  'below_rate',             // comp STATED and below floor
  'region_ambiguous',       // eligibility unclear, worth applying but uncertain
  'timezone_strain',        // requires >5h overlap with US Pacific or APAC
  'seniority_mismatch',     // staff/principal/lead-of-leads, or clearly junior
  'crypto_web3',
  'agency_hostile',         // "no agencies, no freelancers, direct only"
  'comp_unstated',          // informational only — NOT a deduction
  'heavy_process',          // multi-round + take-home + portfolio presentation
] as const;

export const RESUME_VARIANTS = [
  'product-design',
  'design-engineer',
  'ai-training',
] as const;

/**
 * gettranzport and agta are dropped as of 2026-09-12 — their Problem / What I did /
 * Hard part sections were never completed, and the drafter must not select a case
 * study it cannot quote from. Re-adding one is this line plus a knowledge table row.
 */
export const CASE_STUDIES = [
  'rentos',
  'payafta',
  'pocketlawyers',
  'vouchera',
] as const;

export type CaseStudy = (typeof CASE_STUDIES)[number];
export type ResumeVariant = (typeof RESUME_VARIANTS)[number];
export type HardZero = (typeof HARD_ZEROS)[number];
export type RedFlag = (typeof RED_FLAGS)[number];
export type AnyFlag = HardZero | RedFlag;

export const ALL_FLAGS: readonly AnyFlag[] = [...HARD_ZEROS, ...RED_FLAGS];
