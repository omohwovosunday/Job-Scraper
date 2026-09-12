/**
 * worker/sources/remoteok.ts
 *
 * RemoteOK public JSON feed. Returns the most recent ~100 postings.
 *
 * Terms: element 0 of the feed carries RemoteOK's API terms of service, which ask
 * that anyone *republishing* the data link back with a followable link and credit
 * Remote OK as the source, and that the logo not be reused. This agent publishes
 * nothing — it reads listings so one person can apply to jobs — so there is no page
 * on which a link-back could appear. If any of this data is ever surfaced publicly
 * (a shared dashboard, a write-up), the attribution obligation applies and must be
 * honoured. The notice is logged on every run so it stays visible.
 *
 * Feed quirks that matter, all confirmed against live data:
 *   - `description` is entity-encoded HTML, not text.
 *   - `location` is frequently an empty string; eligibility lives in the body.
 *   - `salary_min` / `salary_max` are 0 when compensation is unstated. Zero must
 *     become null, or the scorer reads $0 as below-floor and applies a red flag
 *     where the correct reading is neutral.
 *   - `apply_url` points back to RemoteOK, not the employer, so the resolver has
 *     to follow through to find a real apply path.
 */

import { blankToNull, htmlToText } from '../lib/text.js';
import type { RawListing, Source } from './types.js';

const FEED_URL = 'https://remoteok.com/api';
const SLUG = 'remoteok';

/** RemoteOK returns 403 with no body to an unrecognised agent. */
const USER_AGENT = 'Mozilla/5.0 (compatible; job-scraper/0.1; personal job search)';

type LegalNotice = { legal: string; last_updated?: number };

type FeedEntry = {
  id?: string | number;
  slug?: string;
  company?: string;
  position?: string;
  description?: string;
  location?: string;
  date?: string;
  epoch?: number;
  url?: string;
  apply_url?: string;
  salary_min?: number | string;
  salary_max?: number | string;
};

function isLegalNotice(entry: unknown): entry is LegalNotice {
  return typeof entry === 'object' && entry !== null && 'legal' in entry;
}

/** 0, "0" and absent all mean "not stated" here. Only real figures survive. */
function compFromSalaryRange(
  min: number | string | undefined,
  max: number | string | undefined,
): string | null {
  const toPositive = (v: number | string | undefined): number | null => {
    if (v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const lo = toPositive(min);
  const hi = toPositive(max);
  const fmt = (n: number) => `$${n.toLocaleString('en-US')}`;

  if (lo !== null && hi !== null) return lo === hi ? fmt(lo) : `${fmt(lo)} - ${fmt(hi)}`;
  if (lo !== null) return `from ${fmt(lo)}`;
  if (hi !== null) return `up to ${fmt(hi)}`;
  return null;
}

function parsePostedAt(entry: FeedEntry): Date | null {
  if (typeof entry.date === 'string') {
    const d = new Date(entry.date);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof entry.epoch === 'number' && Number.isFinite(entry.epoch)) {
    const d = new Date(entry.epoch * 1000);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function toRawListing(entry: FeedEntry): RawListing | null {
  const title = blankToNull(entry.position);
  const url = blankToNull(entry.url) ?? blankToNull(entry.apply_url);
  const sourceId = entry.id === undefined ? blankToNull(entry.slug) : String(entry.id);

  // Title and url are load-bearing: the schema requires both and an application
  // needs somewhere to go. Anything missing them is dropped rather than guessed at.
  if (title === null || url === null || sourceId === null) return null;

  return {
    source: SLUG,
    sourceId,
    company: blankToNull(entry.company),
    title,
    description: htmlToText(entry.description),
    url,
    location: blankToNull(entry.location),
    compRaw: compFromSalaryRange(entry.salary_min, entry.salary_max),
    postedAt: parsePostedAt(entry),
  };
}

export const remoteok: Source = {
  slug: SLUG,

  async fetch(): Promise<RawListing[]> {
    const response = await globalThis.fetch(FEED_URL, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`RemoteOK feed returned ${response.status} ${response.statusText}`);
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error('RemoteOK feed was not a JSON array.');
    }

    const listings: RawListing[] = [];
    let dropped = 0;

    for (const entry of payload) {
      if (isLegalNotice(entry)) {
        console.log(`  remoteok terms: ${entry.legal.split('\n')[0]}`);
        continue;
      }
      if (typeof entry !== 'object' || entry === null) {
        dropped += 1;
        continue;
      }
      const listing = toRawListing(entry as FeedEntry);
      if (listing === null) dropped += 1;
      else listings.push(listing);
    }

    if (dropped > 0) {
      console.log(`  remoteok: dropped ${dropped} entr${dropped === 1 ? 'y' : 'ies'} missing a title or url`);
    }
    return listings;
  },
};
