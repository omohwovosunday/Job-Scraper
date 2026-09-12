/**
 * worker/sources/ashby.ts
 *
 * Ashby public job board API. Unauthenticated GET.
 *   GET https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true
 *
 * The most valuable ATS source for this pipeline, for one reason: it returns
 * structured compensation when the employer opted into pay transparency.
 * Compensation is unstated on the overwhelming majority of listings everywhere
 * else, which means `below_rate` almost never fires and the compensation
 * dimension defaults to neutral. Ashby is where that check does real work.
 *
 * Verified against Ramp (145 jobs), Notion (127), Vanta (105), linear (30) on
 * 2026-09-12:
 *   - Response is {apiVersion, jobs:[]}.
 *   - `compensation` present on all 145 Ramp jobs, with
 *     scrapeableCompensationSalarySummary giving a clean "$211.4K - $290.6K",
 *     and compensationTiers[].components[] behind it carrying compensationType,
 *     interval, currencyCode, minValue, maxValue.
 *   - `updatedAt` does NOT exist. Unused, so harmless.
 *   - Board names are NOT case-sensitive: "Ramp" and "ramp" both return the same
 *     145 jobs. Detection generates lowercase slugs, so this matters — the
 *     opposite assumption would have missed every capitalised board.
 *   - `workplaceType` and `address` exist beyond the documented shape.
 */

import { blankToNull, htmlToText } from '../lib/text.js';
import { BoardNotFoundError, pollBoards, type WatchlistEntry } from './watchlist.js';
import type { RawListing, Source } from './types.js';

const SLUG = 'ashby';
const API = 'https://api.ashbyhq.com/posting-api/job-board';
const USER_AGENT = 'job-scraper/0.1 (personal job search)';

type AshbyComponent = {
  summary?: string;
  compensationType?: string;
  interval?: string;
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
};

type AshbyTier = { tierSummary?: string; components?: AshbyComponent[] };

type AshbyJob = {
  id?: string;
  title?: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  department?: string;
  team?: string;
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  publishedAt?: string;
  employmentType?: string;
  jobUrl?: string;
  applyUrl?: string;
  compensation?: {
    compensationTierSummary?: string;
    scrapeableCompensationSalarySummary?: string;
    compensationTiers?: AshbyTier[];
    summaryComponents?: AshbyComponent[];
  };
};

/**
 * Prefers the pre-built summary strings, falling back to assembling from
 * components. Returns null rather than a partial string: a half-parsed range is
 * worse than no data at all, because the scorer would act on it and set
 * `below_rate` against a number that was never really stated.
 */
export function extractComp(job: AshbyJob): string | null {
  const c = job.compensation;
  if (c === undefined) return null;

  const summary =
    blankToNull(c.scrapeableCompensationSalarySummary) ??
    blankToNull(c.compensationTierSummary) ??
    blankToNull(c.compensationTiers?.[0]?.tierSummary);
  if (summary !== null) return summary;

  const components = c.summaryComponents ?? c.compensationTiers?.[0]?.components ?? [];
  // Equity-only components carry no numbers; the salary one is what matters.
  const salary = components.find((x) => /salary|base/i.test(x.compensationType ?? ''));
  if (salary === undefined) return null;

  const { minValue, maxValue, currencyCode, interval } = salary;
  if (minValue == null && maxValue == null) return blankToNull(salary.summary);

  const amount =
    minValue != null && maxValue != null && minValue !== maxValue
      ? `${minValue.toLocaleString('en-US')} - ${maxValue.toLocaleString('en-US')}`
      : (minValue ?? maxValue as number).toLocaleString('en-US');

  return [
    currencyCode ?? null,
    amount,
    interval !== undefined && interval !== 'NONE' ? `per ${interval.toLowerCase()}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' ');
}

function locationOf(job: AshbyJob): string | null {
  const parts = [
    job.location,
    ...(job.secondaryLocations ?? []).map((l) => l.location),
    job.workplaceType,
  ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return parts.length === 0 ? null : [...new Set(parts)].join(', ');
}

function toRawListing(job: AshbyJob, entry: WatchlistEntry): RawListing | null {
  const title = blankToNull(job.title);
  const url = blankToNull(job.jobUrl) ?? blankToNull(job.applyUrl);
  const id = blankToNull(job.id);
  if (title === null || url === null || id === null) return null;

  const meta = [
    job.department !== undefined ? `Department: ${job.department}` : null,
    job.team !== undefined ? `Team: ${job.team}` : null,
    job.employmentType !== undefined ? `Employment type: ${job.employmentType}` : null,
    job.isRemote !== undefined ? `Remote: ${job.isRemote}` : null,
  ].filter((x): x is string => x !== null);

  const body = blankToNull(job.descriptionPlain) ?? htmlToText(job.descriptionHtml);
  const description = [meta.join('\n'), body]
    .filter((x): x is string => x !== null && x.length > 0)
    .join('\n\n');

  const postedAt = blankToNull(job.publishedAt) === null ? null : new Date(job.publishedAt as string);

  return {
    source: SLUG,
    sourceId: `${entry.board_token}:${id}`,
    company: entry.company,
    title,
    description: description.length === 0 ? null : description,
    url,
    location: locationOf(job),
    compRaw: extractComp(job),
    postedAt: postedAt !== null && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
  };
}

/** Exported so it can be run against a live board without a database. */
export async function fetchBoard(entry: WatchlistEntry): Promise<RawListing[]> {
  const url = `${API}/${encodeURIComponent(entry.board_token)}?includeCompensation=true`;
  const response = await globalThis.fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 404) throw new BoardNotFoundError(SLUG, entry.board_token);
  if (!response.ok) {
    throw new Error(`Ashby board "${entry.board_token}" returned ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { jobs?: unknown };
  if (!Array.isArray(payload.jobs)) {
    throw new Error(`Ashby board "${entry.board_token}" returned no jobs array.`);
  }

  const listings: RawListing[] = [];
  for (const job of payload.jobs) {
    if (typeof job !== 'object' || job === null) continue;
    // isListed false means pulled from the public board but still in the payload.
    if ((job as AshbyJob).isListed === false) continue;
    const listing = toRawListing(job as AshbyJob, entry);
    if (listing !== null) listings.push(listing);
  }
  return listings;
}

export const ashby: Source = {
  slug: SLUG,
  fetch: () => pollBoards(SLUG, fetchBoard),
};

export function ashbyBoardFromUrl(url: string): string | null {
  // Board names are case-insensitive at the API, so normalising is safe.
  const m = /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i.exec(url);
  return m?.[1]?.toLowerCase() ?? null;
}
