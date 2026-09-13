/**
 * worker/sources/lever.ts
 *
 * Lever public postings API. Unauthenticated GET.
 *   GET https://api.lever.co/v0/postings/{slug}?mode=json
 *
 * Verified against gopuff's live board (780 postings) on 2026-09-12:
 *   - Returns a BARE ARRAY, not an object with a jobs key. Greenhouse and Ashby
 *     both wrap; Lever does not.
 *   - `createdAt` is epoch MILLISECONDS, not an ISO string.
 *   - `descriptionPlain` is present on 780 of 780 alongside the HTML
 *     `description`, so the plain text is reliable rather than occasional.
 *   - `lists[]` carries the titled sections (Requirements, What you'll do, ...)
 *     as {text, content}. Eligibility language usually sits in a list rather
 *     than the intro, which is why they are reassembled rather than dropped.
 *   - `workplaceType` is exactly 'remote' | 'onsite' | 'hybrid' — a cleaner
 *     onsite signal than any aggregator provides.
 *   - A dead slug 404s, and an existing board with no openings returns 200 with
 *     an empty array. Those are different things.
 *
 * No compensation on the public feed.
 */

import { blankToNull, htmlToText } from '../lib/text.js';
import { BoardNotFoundError, pollBoards, type WatchlistEntry } from './watchlist.js';
import type { RawListing, Source } from './types.js';

const SLUG = 'lever';
const API = 'https://api.lever.co/v0/postings';
const USER_AGENT = 'job-scraper/0.1 (personal job search)';

type LeverList = { text?: string; content?: string };

type LeverPosting = {
  id?: string;
  text?: string; // the job title
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number; // epoch ms
  descriptionPlain?: string;
  description?: string;
  lists?: LeverList[];
  additionalPlain?: string;
  workplaceType?: string;
  country?: string;
  categories?: {
    commitment?: string;
    department?: string;
    location?: string;
    team?: string;
    allLocations?: string[];
  };
};

/**
 * Lever splits a posting into an intro, titled lists, and a closing block.
 * Reassembled in reading order so the scorer sees the whole thing — the
 * eligibility sentence is usually in a list, not the intro.
 */
function buildDescription(p: LeverPosting): string | null {
  const parts: string[] = [];

  const meta = [
    p.categories?.department !== undefined ? `Department: ${p.categories.department}` : null,
    p.categories?.team !== undefined ? `Team: ${p.categories.team}` : null,
    p.categories?.commitment !== undefined ? `Commitment: ${p.categories.commitment}` : null,
    p.workplaceType !== undefined ? `Workplace: ${p.workplaceType}` : null,
  ].filter((x): x is string => x !== null);
  if (meta.length > 0) parts.push(meta.join('\n'));

  const intro = blankToNull(p.descriptionPlain) ?? htmlToText(p.description);
  if (intro !== null) parts.push(intro);

  for (const list of p.lists ?? []) {
    const heading = blankToNull(list.text);
    const body = htmlToText(list.content);
    if (heading !== null || body !== null) {
      parts.push([heading, body].filter((x) => x !== null).join('\n'));
    }
  }

  const closing = blankToNull(p.additionalPlain);
  if (closing !== null) parts.push(closing);

  const joined = parts.join('\n\n').trim();
  return joined.length === 0 ? null : joined;
}

function locationOf(p: LeverPosting): string | null {
  const parts = [
    p.categories?.location,
    ...(p.categories?.allLocations ?? []),
    p.country,
    // workplaceType is the onsite/hybrid signal; the pre-filter reads this field.
    p.workplaceType,
  ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return parts.length === 0 ? null : [...new Set(parts)].join(', ');
}

function parsePostedAt(p: LeverPosting): Date | null {
  if (typeof p.createdAt !== 'number' || !Number.isFinite(p.createdAt)) return null;
  const d = new Date(p.createdAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toRawListing(p: LeverPosting, entry: WatchlistEntry): RawListing | null {
  const title = blankToNull(p.text);
  const url = blankToNull(p.hostedUrl) ?? blankToNull(p.applyUrl);
  const id = blankToNull(p.id);
  if (title === null || url === null || id === null) return null;

  return {
    source: SLUG,
    // Board-scoped: two companies can both number a posting 1.
    sourceId: `${entry.board_token}:${id}`,
    company: entry.company,
    title,
    description: buildDescription(p),
    url,
    location: locationOf(p),
    compRaw: null, // not exposed on the public feed
    postedAt: parsePostedAt(p),
  };
}

/** Exported so it can be run against a live board without a database. */
export async function fetchBoard(entry: WatchlistEntry): Promise<RawListing[]> {
  const url = `${API}/${encodeURIComponent(entry.board_token)}?mode=json`;
  const response = await globalThis.fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    // 150s. Lever's API is slow in a way the other vendors are not — measured at
    // roughly 10KB/s, and a board returns every posting with its full description
    // in one response. Qonto, on the active watchlist, is 1.2MB and exceeds 60s;
    // gopuff at 8MB did not finish inside 180s and is effectively unfetchable.
    // A board too large to read still fails per-board rather than failing the run.
    signal: AbortSignal.timeout(150_000),
  });

  if (response.status === 404) throw new BoardNotFoundError(SLUG, entry.board_token);
  if (!response.ok) {
    throw new Error(`Lever board "${entry.board_token}" returned ${response.status} ${response.statusText}`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error(`Lever board "${entry.board_token}" did not return an array.`);
  }

  const listings: RawListing[] = [];
  for (const posting of payload) {
    if (typeof posting !== 'object' || posting === null) continue;
    const listing = toRawListing(posting as LeverPosting, entry);
    if (listing !== null) listings.push(listing);
  }
  return listings;
}

export const lever: Source = {
  slug: SLUG,
  fetch: () => pollBoards(SLUG, fetchBoard),
};

export function leverSlugFromUrl(url: string): string | null {
  const m = /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i.exec(url);
  return m?.[1]?.toLowerCase() ?? null;
}
