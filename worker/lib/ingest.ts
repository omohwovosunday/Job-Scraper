/**
 * worker/lib/ingest.ts
 *
 * Fetch every source, hash, deduplicate, insert what is new.
 *
 * Idempotent by construction: the only write is an insert that does nothing on a
 * dedupe_hash conflict. A run killed halfway leaves no partial state worth
 * repairing, and re-running inserts only what the previous run missed. GitHub
 * Actions cron fires late and jobs get cancelled, so this matters.
 */

import { db } from './db.js';
import { dedupeHash } from './dedupe.js';
import type { RawListing, Source } from '../sources/types.js';

export type SourceStats = {
  source: string;
  fetched: number;
  /** Collisions inside a single fetch — the same role listed twice on one board. */
  collapsedInBatch: number;
  inserted: number;
  /** Already present from an earlier run or another board. */
  alreadyKnown: number;
  error?: string;
};

export type IngestResult = {
  perSource: SourceStats[];
  totalInserted: number;
};

type OpportunityRow = {
  source: string;
  source_id: string;
  dedupe_hash: string;
  company: string | null;
  title: string;
  description: string | null;
  url: string;
  location: string | null;
  comp_raw: string | null;
  posted_at: string | null;
  status: 'new';
  /**
   * Set only where the source publishes an application address — in practice only
   * Recruitee. Written at insert time rather than left for the resolver, because
   * the resolver reads rows back from the database and the address would be gone
   * by then: it exists in the feed, not on the page the URL points at.
   */
  apply_method: 'email' | null;
  apply_target: string | null;
};

function toRow(listing: RawListing): OpportunityRow {
  return {
    source: listing.source,
    source_id: listing.sourceId,
    dedupe_hash: dedupeHash(listing),
    company: listing.company,
    title: listing.title,
    description: listing.description,
    url: listing.url,
    location: listing.location,
    comp_raw: listing.compRaw,
    posted_at: listing.postedAt?.toISOString() ?? null,
    status: 'new',
    apply_method: listing.applyEmail == null ? null : 'email',
    apply_target: listing.applyEmail ?? null,
  };
}

/**
 * How promising a location string is for a Lagos-based applicant. Higher wins.
 *
 * This exists because of a real collision. Companies post one role several times,
 * once per region, as separate postings with the same company, title and date —
 * so they share a dedupe_hash by design. GitLab lists the same BDR role for
 * "Remote, North America" and for "Remote, EMEA", and Remote.com splits a single
 * Accountant opening across six European countries.
 *
 * Keeping whichever arrived first means array order decides which variant of a
 * role survives, and the one it discards may be the only one open to Nigeria.
 * Widening the hash to include location is the wrong fix: RemoteOK leaves the
 * location field empty on roughly a third of listings while Greenhouse fills it
 * richly, so location in the hash would stop the same role collapsing across
 * boards, which is the hash's entire purpose.
 */
function eligibilityPreference(location: string | null): number {
  if (location === null) return 1; // unknown; the scorer will flag region_ambiguous
  const l = location.toLowerCase();
  if (/worldwide|global|anywhere/.test(l)) return 5;
  if (/emea|africa/.test(l)) return 4;          // EMEA includes Nigeria
  if (/hybrid|on-?site|in-office/.test(l)) return 0;  // hard zero either way
  return 2;                                      // a specific country or city
}

/**
 * Postgres handles a conflicting row fine, but duplicate keys inside one payload
 * are wasted work and make the counts lie. Collapse them here so `inserted` and
 * `alreadyKnown` mean what they say — and when two postings collide, keep the most
 * promising rather than the first one seen.
 */
function collapseByHash(rows: OpportunityRow[]): {
  unique: OpportunityRow[];
  collapsed: number;
} {
  const byHash = new Map<string, OpportunityRow>();
  for (const row of rows) {
    const existing = byHash.get(row.dedupe_hash);
    if (existing === undefined) {
      byHash.set(row.dedupe_hash, row);
      continue;
    }
    // Strictly greater, so ties keep the first and the result stays deterministic.
    if (eligibilityPreference(row.location) > eligibilityPreference(existing.location)) {
      byHash.set(row.dedupe_hash, row);
    }
  }
  return { unique: [...byHash.values()], collapsed: rows.length - byHash.size };
}

export const __testing = { eligibilityPreference, collapseByHash };

async function ingestSource(source: Source): Promise<SourceStats> {
  const listings = await source.fetch();
  const { unique, collapsed } = collapseByHash(listings.map(toRow));

  if (unique.length === 0) {
    return {
      source: source.slug,
      fetched: listings.length,
      collapsedInBatch: collapsed,
      inserted: 0,
      alreadyKnown: 0,
    };
  }

  // ignoreDuplicates makes this ON CONFLICT DO NOTHING; the select returns only
  // the rows that were actually written, which is how `inserted` is counted.
  const { data, error } = await db()
    .from('opportunities')
    .upsert(unique, { onConflict: 'dedupe_hash', ignoreDuplicates: true })
    .select('dedupe_hash');

  if (error) throw new Error(`insert failed for ${source.slug}: ${error.message}`);

  const inserted = data?.length ?? 0;
  return {
    source: source.slug,
    fetched: listings.length,
    collapsedInBatch: collapsed,
    inserted,
    alreadyKnown: unique.length - inserted,
  };
}

export async function runIngest(sources: readonly Source[]): Promise<IngestResult> {
  const perSource: SourceStats[] = [];

  for (const source of sources) {
    console.log(`ingest ${source.slug}`);
    try {
      const stats = await ingestSource(source);
      perSource.push(stats);
      console.log(
        `  fetched=${stats.fetched} new=${stats.inserted} known=${stats.alreadyKnown}` +
          (stats.collapsedInBatch > 0 ? ` collapsed=${stats.collapsedInBatch}` : ''),
      );
    } catch (err: unknown) {
      // One board being down must not cost the others their run.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ${source.slug} failed: ${message}`);
      perSource.push({
        source: source.slug,
        fetched: 0,
        collapsedInBatch: 0,
        inserted: 0,
        alreadyKnown: 0,
        error: message,
      });
    }
  }

  return {
    perSource,
    totalInserted: perSource.reduce((sum, s) => sum + s.inserted, 0),
  };
}
