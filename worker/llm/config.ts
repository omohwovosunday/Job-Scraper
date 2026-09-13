/**
 * worker/llm/config.ts
 *
 * Every tunable number lives here. The prompt template reads from this —
 * do not hardcode figures into the prompt text.
 *
 * Commercial figures (rate floors, threshold) are read from the environment with
 * NO committed defaults. This repo is public. See CLAUDE-CODE-INSTRUCTIONS.md 2.3.
 */

import { optionalNumber, requireNumber } from '../lib/env.js';

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
  /**
   * Lower floor for internship, graduate and junior postings, which routinely pay
   * below the standard floor. Without a separate figure, widening the search to
   * those levels would have been undone by below_rate firing on every one of them.
   */
  juniorRateFloorHourlyUSD: number;
  juniorRateFloorMonthlyUSD: number;
  /** Below this a listing is skipped. Start at 75; drop toward 65 once trusted. */
  scoreThreshold: number;
};

let commercialCache: Commercial | undefined;

export function commercial(): Commercial {
  if (commercialCache) return commercialCache;

  const hourly = requireNumber(
    'RATE_FLOOR_HOURLY_USD',
    'Drives the below_rate flag. Without it the scorer cannot judge compensation.',
  );
  const monthly = requireNumber(
    'RATE_FLOOR_MONTHLY_USD',
    'Drives the below_rate flag for full-time-shaped roles.',
  );
  const juniorHourly = requireNumber(
    'RATE_FLOOR_JUNIOR_HOURLY_USD',
    'Floor for internship and junior postings, which pay below the standard floor.',
  );

  commercialCache = {
    rateFloorHourlyUSD: hourly,
    rateFloorMonthlyUSD: monthly,
    juniorRateFloorHourlyUSD: juniorHourly,
    /**
     * Only an hourly junior floor was specified. Rather than invent an unrelated
     * monthly figure, this holds the same ratio to the standard monthly floor as
     * the junior hourly does to the standard hourly — 15/25 of 3,000 is 1,800.
     * Set RATE_FLOOR_JUNIOR_MONTHLY_USD to override it with a real number.
     */
    juniorRateFloorMonthlyUSD:
      optionalNumber('RATE_FLOOR_JUNIOR_MONTHLY_USD') ??
      Math.round((monthly * (juniorHourly / hourly)) / 50) * 50,
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
  // Every engagement shape is acceptable, so there is nothing here for the scorer
  // to deduct on. Seniority is likewise not a filter — internship through staff
  // are all in scope; see the Role fit section of scorer.prompt.md.
  contractTypes: ['contract', 'part-time', 'full-time', 'internship'] as const,
  preferredContractTypes: ['contract', 'part-time', 'full-time'] as const,

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
  // NOT for a role below his experience, and not for one asking more years than
  // he has. Every level from internship to staff is in scope. Reserved for a post
  // with no hands-on design in it at all — managing managers, running a
  // department — which is the wrong job rather than the wrong level.
  'seniority_mismatch',
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
 * The drafter. Unlike the scorer, the model is named here rather than in
 * provider.ts, because there is no provider choice to make: it is always Claude.
 * See draftingModel() for why that is deliberate and not an oversight.
 */
export const DRAFTER_CONFIG = {
  model: 'claude-sonnet-5',

  /**
   * Hard ceilings, not targets. Enforced in code after the model returns, because
   * a word limit in a prompt is a suggestion and this one is load-bearing: an ATS
   * field that silently truncates at its own limit would cut the letter mid-sentence.
   */
  maxWords: {
    email: 150,
    ats_cover_letter: 200,
    free_text_answer: 120,
  },

  /** Below this the draft still gets written, but routes to manual review. */
  minConfidence: 0.7,

  /**
   * Mostly thinking budget, not letter budget.
   *
   * claude-sonnet-5 reasons before answering and those tokens count against
   * max_tokens. At 2048 a measured run spent all 2048 on thinking and returned an
   * empty string with stop_reason max_tokens — a letter of zero characters,
   * reported as "truncated". At 8192 the same request used 1,713 thinking tokens
   * and finished with end_turn.
   *
   * This is the same failure Gemini had with thinking_level: 'low' eating the JSON
   * budget, and it was assumed to be Gemini-specific when it is not. Any model that
   * thinks before answering needs the budget to cover both.
   */
  maxOutputTokens: 8192,
} as const;

export type DraftFormat = keyof typeof DRAFTER_CONFIG.maxWords;
export const DRAFT_FORMATS = Object.keys(DRAFTER_CONFIG.maxWords) as DraftFormat[];

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
