/**
 * worker/sources/index.ts
 *
 * Source registry.
 *
 * Aggregators give breadth; the ATS company boards give speed, because postings
 * land on a company's own board before they propagate. The dedupe hash is what
 * stops the overlap becoming duplicate applications.
 *
 * Himalayas and We Work Remotely earn their place on eligibility data rather than
 * volume: both state worldwide availability positively — "Worldwide", "Anywhere in
 * the World" — which the Greenhouse boards never did once across 1,378 roles.
 */

import { greenhouse } from './greenhouse.js';
import { himalayas } from './himalayas.js';
import { remoteok } from './remoteok.js';
import { wwr } from './wwr.js';
import type { Source } from './types.js';

export const SOURCES: readonly Source[] = [remoteok, wwr, himalayas, greenhouse];

export { fetchBoard, BoardNotFoundError } from './greenhouse.js';
export type { WatchlistEntry } from './greenhouse.js';
export type { RawListing, Source } from './types.js';
