/**
 * worker/sources/index.ts
 *
 * Source registry. Adapters are added in build order: RemoteOK first because it is
 * the simplest feed, then Greenhouse company boards, then the remaining
 * aggregators.
 *
 * Aggregators give breadth. The ATS boards give speed — postings land there before
 * they propagate — so the two are complementary rather than redundant, and the
 * dedupe_hash is what stops the overlap becoming duplicate applications.
 */

import { greenhouse } from './greenhouse.js';
import { remoteok } from './remoteok.js';
import type { Source } from './types.js';

export const SOURCES: readonly Source[] = [remoteok, greenhouse];

export { fetchBoard, BoardNotFoundError } from './greenhouse.js';
export type { WatchlistEntry } from './greenhouse.js';
export type { RawListing, Source } from './types.js';
