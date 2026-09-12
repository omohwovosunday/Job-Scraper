/**
 * worker/sources/greenhouse.ts
 *
 * Greenhouse job board read API. Public, keyless, and unauthenticated — the same
 * endpoint a company's own careers page calls. Postings appear here before they
 * propagate to the aggregators, which is where the speed advantage lives now that
 * ATS submission is out of scope (instructions 3.4).
 *
 *   GET https://boards-api.greenhouse.io/v1/boards/<board_token>/jobs?content=true
 *
 * Confirmed against live boards:
 *   - `content=true` returns every description in the same call, so one request
 *     covers a whole board. Vercel's 86 roles came back as 877KB.
 *   - `content` is entity-encoded HTML, exactly like RemoteOK, so htmlToText
 *     handles both.
 *   - `location.name` is far better structured than the aggregators manage:
 *     "Remote - United States", "Remote - India", "Hybrid - London". That is the
 *     region_restricted and onsite_or_hybrid hard zeros already labelled, and
 *     region is the most common disqualifier for a Lagos-based applicant.
 *   - An unknown board token returns 404, so tokens must be verified before they
 *     go in the watchlist. A 404 marks that row and does not fail the run.
 *   - No structured compensation. compRaw stays null, which the scorer reads as
 *     neutral rather than below-floor.
 *
 * There are no published rate limits. Poll on schedule, not aggressively.
 */

import { blankToNull, htmlToText } from '../lib/text.js';
import { BoardNotFoundError, pollBoards, type WatchlistEntry } from './watchlist.js';
import type { RawListing, Source } from './types.js';

const SLUG = 'greenhouse';
const API = 'https://boards-api.greenhouse.io/v1/boards';
const USER_AGENT = 'job-scraper/0.1 (personal job search)';

type GreenhouseJob = {
  id?: number | string;
  title?: string;
  company_name?: string;
  absolute_url?: string;
  content?: string;
  location?: { name?: string } | null;
  first_published?: string;
  updated_at?: string;
};

function parsePostedAt(job: GreenhouseJob): Date | null {
  for (const raw of [job.first_published, job.updated_at]) {
    if (typeof raw === 'string') {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function toRawListing(job: GreenhouseJob, entry: WatchlistEntry): RawListing | null {
  const title = blankToNull(job.title);
  const url = blankToNull(job.absolute_url);
  const id = job.id === undefined ? null : String(job.id);
  if (title === null || url === null || id === null) return null;

  return {
    source: SLUG,
    // Board-scoped: two companies can both have a job numbered 1.
    sourceId: `${entry.board_token}:${id}`,
    company: blankToNull(job.company_name) ?? entry.company,
    title,
    description: htmlToText(job.content),
    url,
    location: blankToNull(job.location?.name),
    compRaw: null,
    postedAt: parsePostedAt(job),
  };
}

/**
 * Fetches one board. Exported so it can be exercised against a live board without
 * a database — the watchlist lookup is the only part that needs Supabase.
 */
export async function fetchBoard(entry: WatchlistEntry): Promise<RawListing[]> {
  const url = `${API}/${encodeURIComponent(entry.board_token)}/jobs?content=true`;
  const response = await globalThis.fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });

  if (response.status === 404) throw new BoardNotFoundError(SLUG, entry.board_token);
  if (!response.ok) {
    throw new Error(
      `Greenhouse board "${entry.board_token}" returned ${response.status} ${response.statusText}`,
    );
  }

  const payload: unknown = await response.json();
  const jobs =
    typeof payload === 'object' && payload !== null && Array.isArray((payload as { jobs?: unknown }).jobs)
      ? ((payload as { jobs: unknown[] }).jobs)
      : null;
  if (jobs === null) {
    throw new Error(`Greenhouse board "${entry.board_token}" returned no jobs array.`);
  }

  const listings: RawListing[] = [];
  for (const job of jobs) {
    if (typeof job !== 'object' || job === null) continue;
    const listing = toRawListing(job as GreenhouseJob, entry);
    if (listing !== null) listings.push(listing);
  }
  return listings;
}

export const greenhouse: Source = {
  slug: SLUG,
  fetch: () => pollBoards(SLUG, fetchBoard),
};
