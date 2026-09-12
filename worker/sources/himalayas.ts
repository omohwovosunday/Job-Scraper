/**
 * worker/sources/himalayas.ts
 *
 * Himalayas public JSON API. The best-structured source in the system.
 *
 * Confirmed against the live API:
 *   - `locationRestrictions` is an array of country names. EMPTY MEANS NO
 *     RESTRICTION — genuinely worldwide. That is a fact no other source states
 *     positively, and it is exactly the fact that decides eligibility here.
 *   - `timezoneRestrictions` is an array of UTC offsets. Empty means any. Lagos is
 *     UTC+1, so an array that omits 1 is a real restriction even when the location
 *     list is empty.
 *   - Salary is structured: minSalary, maxSalary, currency, salaryPeriod.
 *   - `description` is real HTML, not entity-encoded.
 *   - `pubDate` and `expiryDate` are epoch seconds.
 *
 * Two constraints shape the polling:
 *   - totalCount is ~98,700. The whole corpus is not ingestable and should not be.
 *   - Page size is fixed at 20; the documented `limit` parameter is ignored, and so
 *     is every category or search filter tried against it.
 *
 * So this reads the most recent pages only, ordered newest first, and relies on the
 * dedupe hash plus a 20-minute cron to catch new postings as they appear. Paging
 * the full corpus would be ~4,900 requests per run, which would be abusive and
 * would find nothing the next run wouldn't.
 */

import { blankToNull, htmlToText } from '../lib/text.js';
import type { RawListing, Source } from './types.js';

const SLUG = 'himalayas';
const API = 'https://himalayas.app/jobs/api';
const USER_AGENT = 'job-scraper/0.1 (personal job search)';

/** 10 pages of 20 = the 200 most recent postings per run. */
const MAX_PAGES = 10;
const POLITENESS_DELAY_MS = 900;

/** Lagos. An explicit timezone list that omits this is a restriction. */
const LOCAL_UTC_OFFSET = 1;

type HimalayasJob = {
  title?: string;
  companyName?: string;
  description?: string;
  excerpt?: string;
  applicationLink?: string;
  guid?: string;
  locationRestrictions?: unknown;
  timezoneRestrictions?: unknown;
  minSalary?: unknown;
  maxSalary?: unknown;
  currency?: string;
  salaryPeriod?: string;
  pubDate?: unknown;
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
}

/**
 * Renders both eligibility fields into the one location string the rest of the
 * pipeline reads.
 *
 * An empty restriction list becomes the word "Worldwide" rather than an empty
 * string. That is not decoration: the pre-filter treats an empty location as
 * unknown and passes it through, while "Worldwide" is a positive statement it can
 * act on, and it is what the API actually means.
 *
 * A timezone restriction excluding UTC+1 is appended as readable text. The
 * pre-filter will not act on it — by design, since it under-excludes — but the
 * scorer reads the field and can flag timezone_strain or region_restricted.
 */
export function locationFrom(locations: string[], timezones: number[]): string {
  const base = locations.length === 0 ? 'Worldwide' : locations.join(', ');
  if (timezones.length === 0) return base;
  if (timezones.includes(LOCAL_UTC_OFFSET)) return base;

  const lo = Math.min(...timezones);
  const hi = Math.max(...timezones);
  return `${base} (timezones UTC${lo >= 0 ? '+' : ''}${lo} to UTC${hi >= 0 ? '+' : ''}${hi}, excludes UTC+1)`;
}

/** Structured salary into the comp_raw text the scorer reads. */
export function compFrom(job: HimalayasJob): string | null {
  const toPositive = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const lo = toPositive(job.minSalary);
  const hi = toPositive(job.maxSalary);
  if (lo === null && hi === null) return null;

  const currency = blankToNull(job.currency) ?? 'USD';
  const period = blankToNull(job.salaryPeriod);
  const fmt = (n: number) => n.toLocaleString('en-US');

  const amount =
    lo !== null && hi !== null ? (lo === hi ? fmt(lo) : `${fmt(lo)} - ${fmt(hi)}`)
      : lo !== null ? `from ${fmt(lo)}`
      : `up to ${fmt(hi as number)}`;

  return `${currency} ${amount}${period === null ? '' : ` per ${period.replace(/ly$/, '')}`}`;
}

function parsePubDate(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // Epoch seconds, not milliseconds.
  const d = new Date(value * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toRawListing(job: HimalayasJob): RawListing | null {
  const title = blankToNull(job.title);
  const url = blankToNull(job.applicationLink) ?? blankToNull(job.guid);
  const sourceId = blankToNull(job.guid) ?? url;
  if (title === null || url === null || sourceId === null) return null;

  return {
    source: SLUG,
    sourceId,
    company: blankToNull(job.companyName),
    title,
    description: htmlToText(job.description) ?? blankToNull(job.excerpt),
    url,
    location: locationFrom(asStringArray(job.locationRestrictions), asNumberArray(job.timezoneRestrictions)),
    compRaw: compFrom(job),
    postedAt: parsePubDate(job.pubDate),
  };
}

type ApiResponse = { jobs?: unknown; nextCursor?: unknown; totalCount?: unknown };

export const himalayas: Source = {
  slug: SLUG,

  async fetch(): Promise<RawListing[]> {
    const all: RawListing[] = [];
    let cursor: string | null = null;
    let pages = 0;

    while (pages < MAX_PAGES) {
      const url = cursor === null ? API : `${API}?cursor=${encodeURIComponent(cursor)}`;
      const response = await globalThis.fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`Himalayas returned ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as ApiResponse;
      const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
      if (jobs.length === 0) break;

      for (const job of jobs) {
        if (typeof job !== 'object' || job === null) continue;
        const listing = toRawListing(job as HimalayasJob);
        if (listing !== null) all.push(listing);
      }

      pages += 1;
      // Cursor paging is the documented preference; offset is deprecated and can
      // return the same job twice.
      cursor = typeof payload.nextCursor === 'string' && payload.nextCursor !== '' ? payload.nextCursor : null;
      if (cursor === null) break;

      await new Promise((r) => setTimeout(r, POLITENESS_DELAY_MS));
    }

    console.log(`  himalayas: ${all.length} listings from ${pages} page(s) of the most recent postings`);
    return all;
  },
};
