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
  };
}

/**
 * Postgres handles a conflicting row fine, but duplicate keys inside one payload
 * are wasted work and make the counts lie. Collapse them here so `inserted` and
 * `alreadyKnown` mean what they say.
 */
function collapseByHash(rows: OpportunityRow[]): {
  unique: OpportunityRow[];
  collapsed: number;
} {
  const byHash = new Map<string, OpportunityRow>();
  for (const row of rows) {
    if (!byHash.has(row.dedupe_hash)) byHash.set(row.dedupe_hash, row);
  }
  return { unique: [...byHash.values()], collapsed: rows.length - byHash.size };
}

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
