/**
 * scripts/check-ats.ts
 *
 * The per-company ATS adapters and watchlist detection, against live boards.
 * Needs no database and no API keys.
 *
 *   npm run check:ats
 */

import { dedupeHash } from '../worker/lib/dedupe.js';
import { fetchBoard as fetchLever, leverSlugFromUrl } from '../worker/sources/lever.js';
import { fetchBoard as fetchAshby, ashbyBoardFromUrl, extractComp } from '../worker/sources/ashby.js';
import { candidateSlugs, detectFromUrl, INGESTABLE } from '../worker/sources/detect.js';
import { BoardNotFoundError } from '../worker/sources/watchlist.js';
import type { RawListing } from '../worker/sources/types.js';

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

function markupResidue(text: string): boolean {
  return /<\/?[a-z][^<>]*>|&[a-z]+;|&#\d+;|base64,/i.test(text);
}

function shared(name: string, listings: RawListing[], tokenPrefix: string): void {
  check(`${name}: fetched ${listings.length} listings`, listings.length > 0);
  check(`${name}: every listing has a title and url`,
    listings.every((l) => l.title.length > 0 && l.url.length > 0));
  check(`${name}: source ids are board-scoped and unique`,
    new Set(listings.map((l) => l.sourceId)).size === listings.length &&
      listings.every((l) => l.sourceId.startsWith(`${tokenPrefix}:`)));
  check(`${name}: no markup residue in descriptions`,
    listings.every((l) => !markupResidue(l.description ?? '')));
  check(`${name}: descriptions are non-empty`,
    listings.every((l) => (l.description ?? '').length > 0));
  check(`${name}: hashes are deterministic`,
    listings.map(dedupeHash).every((h, i) => h === dedupeHash(listings[i]!)));
}

async function leverAdapter(): Promise<void> {
  console.log('\nLever adapter (live: gopuff)');
  const listings = await fetchLever({ company: 'Gopuff', board_token: 'gopuff' });
  shared('lever', listings, 'gopuff');

  // createdAt is epoch ms. Treating it as seconds would date everything to 1970.
  const dated = listings.filter((l) => l.postedAt !== null);
  check(`lever: postedAt parsed on ${dated.length}/${listings.length}`, dated.length > 0);
  const years = new Set(dated.map((l) => l.postedAt!.getUTCFullYear()));
  check(`lever: epoch ms read correctly (years ${[...years].sort().join(', ')})`,
    [...years].every((y) => y >= 2015 && y <= 2030), JSON.stringify([...years]));

  // The titled lists carry the eligibility language; dropping them would lose it.
  const withLists = listings.filter((l) => (l.description ?? '').length > 1500);
  check(`lever: descriptions include the list sections (${withLists.length} over 1500 chars)`,
    withLists.length > 0);
  check('lever: workplaceType reaches the location field',
    listings.some((l) => /remote|onsite|hybrid/i.test(l.location ?? '')));
  check('lever: comp is null, not a fabricated value',
    listings.every((l) => l.compRaw === null));

  console.log('\n  bad slug is reported, not fatal');
  try {
    await fetchLever({ company: 'Nope', board_token: 'definitely-not-a-lever-board-xyz' });
    check('lever: 404 raises BoardNotFoundError', false, 'no error thrown');
  } catch (err: unknown) {
    check('lever: 404 raises BoardNotFoundError', err instanceof BoardNotFoundError,
      err instanceof Error ? err.constructor.name : String(err));
  }
}

async function ashbyAdapter(): Promise<void> {
  console.log('\nAshby adapter (live: Ramp)');
  const listings = await fetchAshby({ company: 'Ramp', board_token: 'ramp' });
  shared('ashby', listings, 'ramp');

  // The reason Ashby is worth having: it is the only source that states comp.
  const withComp = listings.filter((l) => l.compRaw !== null);
  console.log(`  comp stated on ${withComp.length}/${listings.length}`);
  check('ashby: compensation is extracted', withComp.length > 0);
  check('ashby: no comp string is a bare or partial number',
    withComp.every((l) => /\d/.test(l.compRaw!) && l.compRaw!.trim().length > 3),
    JSON.stringify(withComp.slice(0, 2).map((l) => l.compRaw)));
  console.log(`  examples: ${JSON.stringify(withComp.slice(0, 3).map((l) => l.compRaw))}`);

  // A partial parse is worse than nothing: the scorer would set below_rate
  // against a figure the employer never stated.
  check('ashby: equity-only compensation yields null rather than a number-less string',
    extractComp({ compensation: { summaryComponents: [
      { compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null, maxValue: null },
    ] } }) === null);
  check('ashby: a summary string is preferred over components',
    extractComp({ compensation: {
      scrapeableCompensationSalarySummary: '$100K - $150K',
      summaryComponents: [{ compensationType: 'Salary', minValue: 1, maxValue: 2, currencyCode: 'USD', interval: '1 YEAR' }],
    } }) === '$100K - $150K');
  check('ashby: components assemble when no summary exists',
    extractComp({ compensation: { summaryComponents: [
      { compensationType: 'Salary', minValue: 120000, maxValue: 160000, currencyCode: 'USD', interval: '1 YEAR' },
    ] } }) === 'USD 120,000 - 160,000 per 1 year');
  check('ashby: no compensation object yields null', extractComp({}) === null);

  console.log('\n  bad board is reported, not fatal');
  try {
    await fetchAshby({ company: 'Nope', board_token: 'definitely-not-an-ashby-board-xyz' });
    check('ashby: 404 raises BoardNotFoundError', false, 'no error thrown');
  } catch (err: unknown) {
    check('ashby: 404 raises BoardNotFoundError', err instanceof BoardNotFoundError,
      err instanceof Error ? err.constructor.name : String(err));
  }
}

function urlParsing(): void {
  console.log('\nURL parsing');
  const cases: [string, string | null, string | null][] = [
    ['https://jobs.lever.co/netlify/abc-123', 'netlify', null],
    ['https://jobs.eu.lever.co/monzo', 'monzo', null],
    ['https://jobs.ashbyhq.com/Ramp/1234', null, 'ramp'],
    ['https://jobs.ashbyhq.com/openai', null, 'openai'],
    ['https://acme.com/careers', null, null],
  ];
  for (const [url, lv, ab] of cases) {
    check(`lever  ${url.slice(8, 44).padEnd(36)} -> ${lv}`, leverSlugFromUrl(url) === lv,
      `got ${leverSlugFromUrl(url)}`);
    check(`ashby  ${url.slice(8, 44).padEnd(36)} -> ${ab}`, ashbyBoardFromUrl(url) === ab,
      `got ${ashbyBoardFromUrl(url)}`);
  }
  // Ashby board names are case-insensitive at the API, confirmed live, so
  // lowercasing is safe and lets detection's lowercase slugs match.
  check('ashby board names are lowercased', ashbyBoardFromUrl('https://jobs.ashbyhq.com/Ramp') === 'ramp');
}

function detection(): void {
  console.log('\nwatchlist detection');
  for (const [name, expected] of [
    ['Acme Labs, Inc.', ['acmelabs', 'acme-labs', 'acme']],
    ['Ramp', ['ramp']],
    ['Foo Bar Ltd', ['foobar', 'foo-bar', 'foo']],
  ] as [string, string[]][]) {
    const got = candidateSlugs(name);
    check(`slugs for "${name}" -> ${JSON.stringify(got)}`,
      JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(expected));
  }

  const urls: [string, string][] = [
    ['https://boards.greenhouse.io/stripe', 'greenhouse/stripe'],
    ['https://jobs.lever.co/netlify/abc', 'lever/netlify'],
    ['https://jobs.ashbyhq.com/Ramp/1', 'ashby/ramp'],
    ['https://acme.workable.com/j/ABC', 'workable/acme'],
    ['https://acme.breezy.hr/p/xyz', 'breezy/acme'],
  ];
  for (const [url, expected] of urls) {
    const d = detectFromUrl(url);
    check(`${url.slice(8, 46).padEnd(38)} -> ${expected}`,
      d !== null && `${d.vendor}/${d.token}` === expected,
      d === null ? 'null' : `${d.vendor}/${d.token}`);
  }
  check('a plain careers page is not guessed at', detectFromUrl('https://acme.com/careers') === null);
  check('only vendors with adapters are marked ingestable',
    INGESTABLE.length === 3 && !INGESTABLE.includes('workable'));
}

async function main(): Promise<void> {
  urlParsing();
  detection();
  await leverAdapter();
  await ashbyAdapter();

  console.log('');
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('All ATS adapter checks passed.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
