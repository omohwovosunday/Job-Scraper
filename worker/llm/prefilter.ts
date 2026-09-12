/**
 * worker/llm/prefilter.ts
 *
 * Decides what never reaches the model.
 *
 * Measured over the 1,392 rows currently held: 56 are design roles by title, and 4
 * of those are not already excluded by their own location field. Scoring all 1,392
 * would be ~140 Haiku calls to rediscover what the employers already wrote down —
 * "Remote - United States" excludes a Lagos applicant, and no amount of reasoning
 * changes that.
 *
 * The bar for excluding something here is deliberately high. A pre-filter mistake
 * is invisible: the listing is marked skipped and nobody ever looks at it. So this
 * only acts on statements the employer made explicitly, and anything ambiguous —
 * an empty location, an unfamiliar phrasing — goes through to the scorer, which has
 * region_ambiguous for exactly that case.
 */

import type { HardZero } from './config.js';

export type PrefilterVerdict =
  | { pass: true }
  | { pass: false; flag: HardZero | 'role_mismatch'; reason: string };

/**
 * Locations that exclude Nigeria. Matched against the location field only, never
 * the description — prose says "our US team" for all sorts of reasons, while the
 * location field is the employer stating where they will hire.
 */
const REGION_EXCLUSIONS: { re: RegExp; label: string }[] = [
  { re: /\b(?:united states|usa|u\.s\.a?\.?|us)\b/i, label: 'US only' },
  { re: /\bus\s*(?:\/|or|&|and)\s*canada\b/i, label: 'US or Canada only' },
  { re: /\bnorth america\b|\bnoram\b|\bamer\b/i, label: 'North America only' },
  { re: /\bcanada\b/i, label: 'Canada only' },
  { re: /\b(?:latam|latin america)\b/i, label: 'LATAM only' },
  { re: /\b(?:apac|asia[- ]pacific)\b/i, label: 'APAC only' },
  { re: /\bunited kingdom\b|\buk&?i\b|\bgreat britain\b/i, label: 'UK only' },
  { re: /\b(?:european union|\beu\b)[- ]only\b/i, label: 'EU only' },
];

/** Overrides an exclusion: a region that does include Nigeria. */
const REGION_INCLUSIONS = /\b(?:worldwide|global|anywhere|emea|africa|nigeria|remote[- ]?first)\b/i;

const ONSITE = /\b(?:hybrid|on[- ]?site|onsite|in[- ]office|in[- ]person|relocat)/i;

/**
 * Titles that are not this candidate's work at all. Kept narrow: this rejects
 * clearly-unrelated functions, not "adjacent design role I would think about".
 * The scorer handles judgement; this only removes the obvious.
 */
const CLEARLY_NOT_DESIGN =
  /\b(?:account executive|sales development|sdr|bdr|business development|payroll|accountant|accounting|tax analyst|controller|bookkeep|recruiter|talent acquisition|customer success|support engineer|solutions? architect|nurse|physician|clinical|warehouse|driver|mechanical engineer|industrial design engineer|attorney|paralegal|teacher|professor)\b/i;

/**
 * Design-adjacent signal. Used only to decide whether a role is plausibly relevant
 * enough to spend a scoring call on — not to judge fit.
 */
const DESIGN_SIGNAL =
  /\b(?:designer|design|ux|ui|user experience|user interface|product design|design system|creative|brand|visual|front[- ]?end|frontend|webflow|figma|prototyp)\b/i;

/**
 * Boards write the same restriction several ways — "Remote - US", "Remote-US",
 * "Remote — US". Collapsing dashes to spaces means one pattern covers all of them
 * instead of three near-duplicates that each miss a variant.
 */
function normaliseLocation(location: string): string {
  return location.replace(/\s*[-–—]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

export function prefilter(input: {
  title: string;
  location: string | null;
  applyMethod: string | null;
}): PrefilterVerdict {
  const location = normaliseLocation(input.location ?? '');

  // An employer naming a region that includes Nigeria overrides any other region
  // phrasing in the same field — "Remote, EMEA; Remote, United Kingdom" is open.
  const includesUs = REGION_INCLUSIONS.test(location);

  if (!includesUs && ONSITE.test(location)) {
    return { pass: false, flag: 'onsite_or_hybrid', reason: `location requires presence: ${location}` };
  }

  if (!includesUs && location !== '') {
    for (const exclusion of REGION_EXCLUSIONS) {
      if (exclusion.re.test(location)) {
        return {
          pass: false,
          flag: 'region_restricted',
          reason: `${exclusion.label} per the location field: ${location}`,
        };
      }
    }
  }

  if (CLEARLY_NOT_DESIGN.test(input.title) && !DESIGN_SIGNAL.test(input.title)) {
    return { pass: false, flag: 'role_mismatch', reason: `not a design role: ${input.title}` };
  }

  if (!DESIGN_SIGNAL.test(input.title)) {
    return { pass: false, flag: 'role_mismatch', reason: `no design signal in title: ${input.title}` };
  }

  return { pass: true };
}

/**
 * The scorer prompt truncates descriptions. A flat head cut is the wrong shape:
 * eligibility lines sit at the FOOT of a long listing, after the benefits and the
 * equal-opportunity boilerplate, and the longest description seen so far ran to
 * 18,894 characters against a 4,000 budget. Cutting the head only would throw away
 * precisely the sentence that decides the hard zero.
 */
export function truncateForScoring(description: string | null, budget = 4000): string {
  if (description === null) return '';
  if (description.length <= budget) return description;

  const headSize = Math.floor(budget * 0.625);
  const tailSize = budget - headSize;
  const head = description.slice(0, headSize);
  const tail = description.slice(-tailSize);
  return `${head}\n\n[...${description.length - budget} characters omitted...]\n\n${tail}`;
}
