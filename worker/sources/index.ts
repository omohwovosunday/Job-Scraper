/**
 * worker/sources/index.ts
 *
 * Source registry. Adapters are added in build order: RemoteOK first because it is
 * the simplest feed, then one Greenhouse board, then the remaining aggregators.
 */

import { remoteok } from './remoteok.js';
import type { Source } from './types.js';

export const SOURCES: readonly Source[] = [remoteok];

export type { RawListing, Source } from './types.js';
