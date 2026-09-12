/**
 * worker/sources/types.ts
 *
 * Common shape every board adapter normalises to. One adapter per source, each
 * exporting fetch(): Promise<RawListing[]>.
 */

export type RawListing = {
  /** Board slug: 'remoteok' | 'wwr' | 'himalayas' | 'greenhouse' | ... */
  source: string;
  /** The board's own id for this posting. Not stable across boards. */
  sourceId: string;
  company: string | null;
  title: string;
  /** Plain text. Adapters strip markup — the scorer should never see HTML. */
  description: string | null;
  url: string;
  /** Free text as published. Often empty; eligibility usually hides in the body. */
  location: string | null;
  /**
   * Compensation exactly as published, or null when the board says nothing.
   * Null and "unstated" must stay distinguishable from a real zero: the scorer
   * treats missing comp as neutral and below-floor comp as a red flag, so a board
   * sentinel of 0 leaking through here would invert that judgement.
   */
  compRaw: string | null;
  postedAt: Date | null;
};

export type Source = {
  /** Matches RawListing.source. */
  readonly slug: string;
  fetch(): Promise<RawListing[]>;
};
