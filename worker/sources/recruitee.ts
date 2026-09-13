/**
 * worker/sources/recruitee.ts
 *
 * Recruitee public offers API. Unauthenticated GET.
 *   GET https://{company}.recruitee.com/api/offers/
 *
 * The most useful ATS source in the project, for a reason none of the others can
 * match: every offer publishes `mailbox_email`, a per-job address that routes mail
 * into the employer's own applicant tracking system as a candidate record.
 *
 * That matters because across 2,557 listings from six sources, the apply path was
 * 2,224 ats and 333 form and ZERO email — and email is the only channel a machine
 * can use. Greenhouse, Lever and Ashby all gate their application endpoints behind
 * a key the employer holds; RemoteOK obfuscates its outbound link and We Work
 * Remotely and Himalayas 403 non-browser agents. Recruitee simply publishes the
 * address. It is the only automated application path found anywhere.
 *
 * NOT YET PROVEN END TO END. The address is published and its documented purpose
 * is receiving applications, but nothing has been sent through one. Treat the
 * first live send as an experiment and check it lands as a candidate rather than
 * bouncing.
 *
 * Verified against hostaway (8 offers) and timedoctor (4) on 2026-09-13:
 *   - `{offers: [...]}`, with remote / hybrid / on_site as real booleans plus
 *     city and country — better eligibility data than any aggregator provides.
 *   - `salary` is a structured {min, max, period, currency}, though both boards
 *     sampled left it empty.
 *   - `description` and `requirements` are separate HTML fields; the eligibility
 *     sentence often sits in requirements, so both are kept.
 *   - mailbox_email present on 12 of 12.
 */

import { blankToNull, htmlToText } from '../lib/text.js';
import { isPlausibleApplicationEmail } from '../resolve/patterns.js';
import { BoardNotFoundError, pollBoards, type WatchlistEntry } from './watchlist.js';
import type { RawListing, Source } from './types.js';

const SLUG = 'recruitee';
const USER_AGENT = 'job-scraper/0.1 (personal job search)';

type RecruiteeSalary = {
  min?: number | null;
  max?: number | null;
  period?: string | null;
  currency?: string | null;
};

type RecruiteeOffer = {
  id?: number | string;
  title?: string;
  slug?: string;
  status?: string;
  careers_url?: string;
  careers_apply_url?: string;
  mailbox_email?: string | null;
  location?: string;
  city?: string | null;
  country?: string | null;
  remote?: boolean;
  hybrid?: boolean;
  on_site?: boolean;
  department?: string;
  employment_type_code?: string;
  description?: string;
  requirements?: string;
  salary?: RecruiteeSalary;
  published_at?: string;
};

/**
 * Built from the booleans and the place fields rather than the `location` string,
 * which is just "Remote job" on every row and says nothing about eligibility.
 * The city and country are what the pre-filter and scorer need — a role tagged
 * remote but sited in Dublin is usually Europe-only.
 */
function locationOf(o: RecruiteeOffer): string | null {
  const parts: string[] = [];
  if (o.on_site === true) parts.push('On-site');
  else if (o.hybrid === true) parts.push('Hybrid');
  else if (o.remote === true) parts.push('Remote');

  const place = [blankToNull(o.city), blankToNull(o.country)]
    .filter((x): x is string => x !== null)
    .join(', ');
  if (place.length > 0) parts.push(place);

  return parts.length === 0 ? blankToNull(o.location) : parts.join(' - ');
}

export function compFrom(salary: RecruiteeSalary | undefined): string | null {
  if (salary === undefined) return null;
  const min = typeof salary.min === 'number' && salary.min > 0 ? salary.min : null;
  const max = typeof salary.max === 'number' && salary.max > 0 ? salary.max : null;
  if (min === null && max === null) return null;

  const currency = blankToNull(salary.currency ?? null) ?? '';
  const period = blankToNull(salary.period ?? null);
  const amount =
    min !== null && max !== null && min !== max
      ? `${min.toLocaleString('en-US')} - ${max.toLocaleString('en-US')}`
      : (min ?? (max as number)).toLocaleString('en-US');

  return [currency, amount, period === null ? null : `per ${period}`]
    .filter((x) => x !== null && x !== '')
    .join(' ');
}

function toRawListing(o: RecruiteeOffer, entry: WatchlistEntry): RawListing | null {
  const title = blankToNull(o.title);
  const url = blankToNull(o.careers_url) ?? blankToNull(o.careers_apply_url);
  const id = o.id === undefined ? null : String(o.id);
  if (title === null || url === null || id === null) return null;

  const meta = [
    o.department !== undefined ? `Department: ${o.department}` : null,
    o.employment_type_code !== undefined ? `Employment type: ${o.employment_type_code}` : null,
  ].filter((x): x is string => x !== null);

  // Requirements is a separate field and routinely carries the eligibility line.
  const body = [htmlToText(o.description), htmlToText(o.requirements)]
    .filter((x): x is string => x !== null)
    .join('\n\n');
  const description = [meta.join('\n'), body].filter((x) => x.length > 0).join('\n\n');

  const posted = blankToNull(o.published_at);
  // "2026-09-04 15:12:15 UTC" — not ISO, so it needs normalising before Date sees it.
  const postedAt = posted === null ? null : new Date(posted.replace(' UTC', 'Z').replace(' ', 'T'));

  const mailbox = blankToNull(o.mailbox_email ?? null);

  return {
    source: SLUG,
    sourceId: `${entry.board_token}:${id}`,
    company: entry.company,
    title,
    description: description.length === 0 ? null : description,
    url,
    location: locationOf(o),
    compRaw: compFrom(o.salary),
    postedAt: postedAt !== null && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
    applyEmail: mailbox !== null && isPlausibleApplicationEmail(mailbox) ? mailbox : null,
  };
}

/** Exported so it can be run against a live board without a database. */
export async function fetchBoard(entry: WatchlistEntry): Promise<RawListing[]> {
  const url = `https://${encodeURIComponent(entry.board_token)}.recruitee.com/api/offers/`;
  const response = await globalThis.fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(40_000),
  });

  if (response.status === 404) throw new BoardNotFoundError(SLUG, entry.board_token);
  if (!response.ok) {
    throw new Error(`Recruitee board "${entry.board_token}" returned ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { offers?: unknown };
  if (!Array.isArray(payload.offers)) {
    throw new Error(`Recruitee board "${entry.board_token}" returned no offers array.`);
  }

  const listings: RawListing[] = [];
  for (const offer of payload.offers) {
    if (typeof offer !== 'object' || offer === null) continue;
    // Drafts and closed roles come back alongside the live ones.
    if ((offer as RecruiteeOffer).status !== undefined && (offer as RecruiteeOffer).status !== 'published') continue;
    const listing = toRawListing(offer as RecruiteeOffer, entry);
    if (listing !== null) listings.push(listing);
  }
  return listings;
}

export const recruitee: Source = {
  slug: SLUG,
  fetch: () => pollBoards(SLUG, fetchBoard),
};

export function recruiteeBoardFromUrl(url: string): string | null {
  const m = /([a-z0-9-]+)\.recruitee\.com/i.exec(url);
  return m?.[1]?.toLowerCase() ?? null;
}
