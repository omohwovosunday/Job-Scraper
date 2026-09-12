/**
 * worker/sources/watchlist.ts
 *
 * Shared watchlist access for the per-company ATS adapters.
 *
 * Every ATS feed is per-company and none is searchable: you cannot ask Ashby for
 * "remote design roles", only for "Ramp's openings". So an ATS adapter with an
 * empty watchlist ingests nothing, however correct it is. The watchlist is the
 * input, not a configuration detail.
 */

import { db } from '../lib/db.js';

export type AtsVendor = 'greenhouse' | 'lever' | 'ashby' | 'workable';

export type WatchlistEntry = {
  id?: string;
  company: string;
  /** The org slug in the vendor's public board URL. */
  board_token: string;
};

export async function loadWatchlist(vendor: AtsVendor): Promise<WatchlistEntry[]> {
  const { data, error } = await db()
    .from('company_watchlist')
    .select('id, company, board_token')
    .eq('ats_vendor', vendor)
    .eq('active', true)
    .order('company');

  if (error) throw new Error(`Failed to load ${vendor} watchlist: ${error.message}`);
  return (data ?? []) as WatchlistEntry[];
}

/**
 * Records the outcome of polling one board. Bookkeeping must never sink a run that
 * already fetched its listings, so a failure here is logged and swallowed.
 */
export async function recordPoll(entry: WatchlistEntry, pollError: string | null): Promise<void> {
  if (entry.id === undefined) return;
  const { error } = await db()
    .from('company_watchlist')
    .update({ last_polled_at: new Date().toISOString(), last_poll_error: pollError })
    .eq('id', entry.id);
  if (error) console.error(`  could not record poll for ${entry.company}: ${error.message}`);
}

export class BoardNotFoundError extends Error {
  constructor(
    public readonly vendor: AtsVendor,
    public readonly boardToken: string,
  ) {
    super(`${vendor} board "${boardToken}" returned 404. The token is wrong or the board was removed.`);
    this.name = 'BoardNotFoundError';
  }
}

/**
 * Fetches every active board for one vendor, keeping a dead token from costing the
 * others their run. Returns listings; per-board errors are recorded on the row.
 */
export async function pollBoards<T>(
  vendor: AtsVendor,
  fetchOne: (entry: WatchlistEntry) => Promise<T[]>,
  delayMs = 400,
): Promise<T[]> {
  const watchlist = await loadWatchlist(vendor);
  if (watchlist.length === 0) {
    console.log(`  ${vendor}: watchlist is empty, nothing to poll`);
    return [];
  }

  const all: T[] = [];
  for (const entry of watchlist) {
    try {
      const listings = await fetchOne(entry);
      all.push(...listings);
      console.log(`  ${vendor}/${entry.board_token}: ${listings.length} listings`);
      await recordPoll(entry, null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ${vendor}/${entry.board_token} failed: ${message}`);
      await recordPoll(entry, message);
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return all;
}
