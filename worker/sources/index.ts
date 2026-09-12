/**
 * worker/sources/index.ts
 *
 * Source registry.
 *
 * Two kinds. Aggregators (RemoteOK, We Work Remotely, Himalayas) are searchable
 * and give breadth. ATS company boards (Greenhouse, Lever, Ashby) are per-company
 * and give speed, because a posting lands there before it propagates anywhere —
 * but an ATS adapter with an empty watchlist ingests nothing, however correct it
 * is. See detect.ts for filling the watchlist from a list of company names.
 *
 * Ashby earns its place on compensation: it is the only source that returns a
 * structured salary range with any regularity, which is the only reason the
 * below_rate check ever fires instead of defaulting to neutral.
 */

import { ashby } from './ashby.js';
import { greenhouse } from './greenhouse.js';
import { himalayas } from './himalayas.js';
import { lever } from './lever.js';
import { remoteok } from './remoteok.js';
import { wwr } from './wwr.js';
import type { Source } from './types.js';

export const SOURCES: readonly Source[] = [remoteok, wwr, himalayas, greenhouse, lever, ashby];

export { BoardNotFoundError, loadWatchlist, pollBoards } from './watchlist.js';
export type { AtsVendor, WatchlistEntry } from './watchlist.js';
export { fetchBoard as fetchGreenhouseBoard } from './greenhouse.js';
export { fetchBoard as fetchLeverBoard, leverSlugFromUrl } from './lever.js';
export { fetchBoard as fetchAshbyBoard, ashbyBoardFromUrl, extractComp } from './ashby.js';
export { candidateSlugs, detectAts, detectFromUrl, detectMany, INGESTABLE } from './detect.js';
export type { Detected, DetectVendor } from './detect.js';
export type { RawListing, Source } from './types.js';
