/**
 * worker/sources/wwr.ts
 *
 * We Work Remotely, one RSS feed per category.
 *
 * Confirmed against the live feed:
 *   - `<region>` is structured eligibility and the reason this source is worth
 *     having: "Anywhere in the World" means exactly that, which is the phrasing the
 *     Greenhouse boards never produced once across 1,378 roles.
 *   - `<title>` packs company and role together as "Pinterest: Content Designer II".
 *     Splitting on the first colon matters — without it every row has a null
 *     company, and company is one of the three inputs to the dedupe hash.
 *   - There is NO pubDate. Not empty, absent. postedAt is therefore null, which the
 *     hash handles consistently: the same role always hashes the same way.
 *   - `<description>` is entity-encoded HTML, same as RemoteOK.
 *   - Feeds are short — 14 items on the design category — so this is cheap to poll.
 *
 * CAVEAT on `<region>`, found by comparing sources. GitLab's "AI Transformation
 * Owner, Product & Design" is listed here as "Anywhere in the World" and on
 * GitLab's own Greenhouse board as "Remote, Canada; Remote, United Kingdom; Remote,
 * United States". The region field is supplied by whoever posted the ad, and it can
 * be wrong in the optimistic direction — which is the dangerous direction here,
 * because it turns a hard zero into an apparent match. Treat "Anywhere in the
 * World" as a claim worth checking in the body, not as an eligibility guarantee.
 * The scorer reads the description, so it has the chance to catch the contradiction.
 */

import Parser from 'rss-parser';
import { blankToNull, htmlToText } from '../lib/text.js';
import type { RawListing, Source } from './types.js';

const SLUG = 'wwr';

/**
 * Design first. Product is adjacent enough to be worth reading — the scorer
 * decides fit, and a product role at a small team is often the design job.
 * Programming is deliberately excluded: the volume is high and the overlap with
 * this candidate's work is thin.
 */
const CATEGORIES = ['remote-design-jobs', 'remote-product-jobs'] as const;

const USER_AGENT = 'Mozilla/5.0 (compatible; job-scraper/0.1; personal job search)';
const POLITENESS_DELAY_MS = 800;

type WwrItem = {
  title?: string;
  link?: string;
  guid?: string;
  content?: string;
  region?: string;
  type?: string;
  category?: string;
  country?: string;
};

const parser: Parser<Record<string, unknown>, WwrItem> = new Parser({
  headers: { 'user-agent': USER_AGENT },
  timeout: 30_000,
  customFields: {
    item: ['region', 'type', 'category', 'country'],
  },
});

/**
 * "Pinterest: Content Designer II, Personalization" -> company + role.
 *
 * Only the first colon splits, and only when both halves look plausible — a title
 * like "Designer: Systems" with no company prefix must not lose its first word.
 */
export function splitCompanyAndTitle(raw: string): { company: string | null; title: string } {
  const at = raw.indexOf(':');
  if (at <= 0) return { company: null, title: raw.trim() };

  const company = raw.slice(0, at).trim();
  const title = raw.slice(at + 1).trim();

  // A company name is short and a role title is not empty. Anything else is
  // likelier to be a colon inside the role name.
  if (company.length === 0 || company.length > 60 || title.length === 0) {
    return { company: null, title: raw.trim() };
  }
  return { company, title };
}

/** Builds the location field from region and country. */
function locationOf(item: WwrItem): string | null {
  const region = blankToNull(item.region);
  const country = blankToNull(item.country);
  if (region !== null && country !== null && !region.toLowerCase().includes(country.toLowerCase())) {
    return `${region} (${country})`;
  }
  return region ?? country;
}

function toRawListing(item: WwrItem): RawListing | null {
  const rawTitle = blankToNull(item.title);
  const url = blankToNull(item.link);
  const sourceId = blankToNull(item.guid) ?? url;
  if (rawTitle === null || url === null || sourceId === null) return null;

  const { company, title } = splitCompanyAndTitle(rawTitle);

  return {
    source: SLUG,
    sourceId,
    company,
    title,
    description: htmlToText(item.content),
    url,
    location: locationOf(item),
    // The feed carries no salary field of any kind.
    compRaw: null,
    // No pubDate in this feed. Null rather than a fabricated "now", which would
    // change the hash on every run and defeat deduplication entirely.
    postedAt: null,
  };
}

export const wwr: Source = {
  slug: SLUG,

  async fetch(): Promise<RawListing[]> {
    const all: RawListing[] = [];

    for (const category of CATEGORIES) {
      const url = `https://weworkremotely.com/categories/${category}.rss`;
      try {
        const feed = await parser.parseURL(url);
        const items = feed.items ?? [];
        let dropped = 0;
        for (const item of items) {
          const listing = toRawListing(item);
          if (listing === null) dropped += 1;
          else all.push(listing);
        }
        console.log(
          `  wwr/${category}: ${items.length - dropped} listings` +
            (dropped > 0 ? ` (${dropped} dropped, missing title or link)` : ''),
        );
      } catch (err: unknown) {
        // One category failing must not cost the others their run.
        console.error(`  wwr/${category} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, POLITENESS_DELAY_MS));
    }

    return all;
  },
};
