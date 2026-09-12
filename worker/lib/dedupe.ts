/**
 * worker/lib/dedupe.ts
 *
 * One role appears on RemoteOK, We Work Remotely and Himalayas under three
 * different ids. The hash is the only thing standing between that and three
 * applications to one job, which is worse than none.
 *
 * dedupe_hash = sha256(normalisedCompany | normalisedTitle | postedDate)
 */

import { createHash } from 'node:crypto';

/** Suffixes that differ between boards for the same employer. */
const COMPANY_SUFFIXES = [
  'incorporated', 'inc',
  'limited', 'ltd',
  'llc', 'lllp', 'llp', 'lp',
  'corporation', 'corp',
  'company', 'co',
  'gmbh', 'ag', 'bv', 'nv', 'oy', 'ab', 'as', 'sa', 'srl', 'spa', 'pte', 'pty',
  'plc', 'kk', 'sas',
];

/**
 * Lowercase, drop punctuation, drop legal suffixes, collapse whitespace.
 * "Acme, Inc." / "ACME Inc" / "Acme" all land on "acme".
 */
export function normaliseCompany(company: string | null | undefined): string {
  if (company === null || company === undefined) return '';

  let out = company
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Suffixes can stack: "Acme Holdings Ltd Co". Strip from the tail repeatedly.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of COMPANY_SUFFIXES) {
      if (out.endsWith(` ${suffix}`)) {
        out = out.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return out;
}

/**
 * Titles vary in decoration between boards for the same role — bracketed
 * locations, seniority in parentheses, trailing "(Remote)".
 */
export function normaliseTitle(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\((?:remote|worldwide|anywhere|global|full[\s-]?time|contract)\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Date only, UTC. Boards timestamp the same posting hours apart, so including the
 * time would defeat the hash. Null dates become an empty segment rather than
 * "now" — two undated postings of the same role should still collide.
 */
export function normalisePostedDate(postedAt: Date | null | undefined): string {
  if (postedAt === null || postedAt === undefined || Number.isNaN(postedAt.getTime())) {
    return '';
  }
  return postedAt.toISOString().slice(0, 10);
}

/**
 * KNOWN LIMIT, measured across 1,617 rows from four sources.
 *
 * The hash catches most duplicates but misses two shapes, and both were observed:
 *
 *   1. Company-name variants. RemoteOK publishes "Interaction Design Foundation";
 *      We Work Remotely publishes "IxDF - Interaction Design Foundation". The
 *      acronym prefix survives normalisation, so the same three IxDF course roles
 *      exist twice. Stripping abbreviation prefixes is a rabbit hole with no end.
 *   2. Disagreeing dates. We Work Remotely publishes no pubDate at all, so its
 *      date segment is empty while another board's is a real date — GitLab's "AI
 *      Transformation Owner" is duplicated across WWR and Greenhouse for exactly
 *      this reason.
 *
 * Only 3-4 genuine duplicates exist in 1,617 rows, but they fall disproportionately
 * in the slice that matters: three of them are IxDF roles, which are three of the
 * four plausible candidates the pre-filter surfaces.
 *
 * The fix does not belong here. Ingest-time dedupe is best-effort by nature, and
 * the guarantee that matters is "never apply twice to one job", which belongs at
 * the send and queue gate where spec 5.5 already checks sent_log. Widening that
 * check to role level — same normalised title at a similar company, already sent —
 * catches both shapes at the only point where a duplicate does harm. Build it with
 * step 9.
 */
export function dedupeHash(input: {
  company: string | null | undefined;
  title: string;
  postedAt: Date | null | undefined;
}): string {
  const parts = [
    normaliseCompany(input.company),
    normaliseTitle(input.title),
    normalisePostedDate(input.postedAt),
  ];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}
