/**
 * scripts/check-ingest.ts
 *
 * Everything about ingest that can be checked without a database: the feed parses,
 * markup is stripped, unstated compensation stays null, and the hash is stable and
 * discriminating. Needs no environment variables.
 *
 *   npx tsx scripts/check-ingest.ts
 */

import { dedupeHash, normaliseCompany, normaliseTitle } from '../worker/lib/dedupe.js';
import { htmlToText } from '../worker/lib/text.js';
import { remoteok } from '../worker/sources/remoteok.js';

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

function companyNormalisation(): void {
  console.log('\ncompany normalisation');
  const groups: string[][] = [
    ['Acme, Inc.', 'ACME Inc', 'Acme', 'acme inc.'],
    ['Foo Bar Ltd', 'Foo Bar Limited', 'foo-bar'],
    ['Widgets GmbH', 'widgets gmbh'],
  ];
  for (const group of groups) {
    const normalised = group.map(normaliseCompany);
    const allSame = new Set(normalised).size === 1;
    check(
      `${group.join(' / ')} -> "${normalised[0]}"`,
      allSame,
      allSame ? '' : `got ${JSON.stringify(normalised)}`,
    );
  }
  check(
    'different companies stay different',
    normaliseCompany('Acme Inc') !== normaliseCompany('Acme Labs'),
  );
}

function titleNormalisation(): void {
  console.log('\ntitle normalisation');
  const same = [
    'Senior Product Designer (Remote)',
    'Senior Product Designer',
    'senior product designer  [EU]',
  ].map(normaliseTitle);
  check(
    `decoration stripped -> "${same[0]}"`,
    new Set(same).size === 1,
    JSON.stringify(same),
  );
  check(
    'seniority is not stripped',
    normaliseTitle('Senior Product Designer') !== normaliseTitle('Product Designer'),
  );
}

function hashing(): void {
  console.log('\nhashing');
  const base = {
    company: 'Acme, Inc.',
    title: 'Senior Product Designer (Remote)',
    postedAt: new Date('2026-09-11T08:00:08+00:00'),
  };

  check('same input, same hash', dedupeHash(base) === dedupeHash({ ...base }));

  check(
    'cross-board variation collides',
    dedupeHash(base) ===
      dedupeHash({
        company: 'ACME Inc',
        title: 'Senior Product Designer',
        // Same calendar day, hours apart — boards timestamp independently.
        postedAt: new Date('2026-09-11T23:14:00+00:00'),
      }),
  );

  check(
    'different day does not collide',
    dedupeHash(base) !== dedupeHash({ ...base, postedAt: new Date('2026-09-12T08:00:00Z') }),
  );
  check(
    'different title does not collide',
    dedupeHash(base) !== dedupeHash({ ...base, title: 'Staff Product Designer' }),
  );
  check(
    'two undated postings of one role still collide',
    dedupeHash({ ...base, postedAt: null }) ===
      dedupeHash({ company: 'Acme', title: 'Senior Product Designer', postedAt: null }),
  );
}

/**
 * Markup residue worth failing on. A bare "<" in prose ("teams of <10 engineers")
 * is legitimate text, so this looks for real tags, real entities, the remnant of a
 * tag left unterminated by truncated source, and inline base64.
 */
function markupResidue(text: string): string[] {
  const patterns: [string, RegExp][] = [
    ['html tag', /<\/?[a-z][^<>]*>/i],
    ['html entity', /&[a-z]+;|&#\d+;/i],
    ['unterminated tag', /<\/?[a-z][^<>]*$/i],
    ['base64 payload', /base64,|data:[a-z]+\/[a-z0-9.+-]+;/i],
  ];
  return patterns.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function htmlStripping(): void {
  console.log('\nhtml stripping');
  const encoded =
    '&lt;h3&gt;Role&lt;/h3&gt;&lt;p&gt;We need a designer.&lt;/p&gt;' +
    '&lt;ul&gt;&lt;li&gt;US &amp;amp; Canada only&lt;/li&gt;&lt;/ul&gt;';
  const text = htmlToText(encoded) ?? '';
  console.log(`  -> ${JSON.stringify(text)}`);
  check('no residue', markupResidue(text).length === 0, markupResidue(text).join(', '));
  check('eligibility text survives', text.includes('US & Canada only'));
  check('empty input is null', htmlToText('') === null && htmlToText(null) === null);

  // Regression: seen live on a RemoteOK listing. An <img> holding a base64 logo,
  // never closed, so the tag-stripping rule had no ">" to match. Left in, the blob
  // consumed the scorer's entire description budget.
  const blob = 'A'.repeat(4000);
  const unterminated = `&lt;p&gt;Must be US based.&lt;/p&gt;&lt;img src="data:image/png;base64,${blob}`;
  const cleaned = htmlToText(unterminated) ?? '';
  const residue = markupResidue(cleaned);
  check('unterminated img with base64 payload is stripped', residue.length === 0,
    residue.join(', '));
  check('eligibility text before the blob survives', cleaned.includes('Must be US based.'));
  check(`result is short (${cleaned.length} chars, was ${unterminated.length})`,
    cleaned.length < 200);

  // Prose comparisons must not be mistaken for markup. Listings write "<3 years"
  // and ">$80k", and a permissive tag regex silently eats the span between them.
  const prose = htmlToText('&lt;p&gt;Teams of &lt;10 engineers. Salary &gt;$80k.&lt;/p&gt;') ?? '';
  console.log(`  -> ${JSON.stringify(prose)}`);
  check('"<10" survives', prose.includes('<10'));
  check('">$80k" survives', prose.includes('>$80k'));
  check('the sentence between them survives', prose.includes('engineers'));

  const yearsReq = htmlToText('&lt;p&gt;Not for you if &lt;3 years of experience.&lt;/p&gt;') ?? '';
  check(`"<3 years" survives: ${JSON.stringify(yearsReq)}`, yearsReq.includes('<3 years'));

  const trailing = htmlToText('&lt;p&gt;It costs &lt;a lot') ?? '';
  check(`trailing prose starting "<a" survives: ${JSON.stringify(trailing)}`,
    trailing.includes('<a lot'));
}

async function liveFeed(): Promise<void> {
  console.log('\nlive RemoteOK feed');
  const listings = await remoteok.fetch();
  check(`fetched ${listings.length} listings`, listings.length > 0);

  const withMarkup = listings
    .map((l) => ({ title: l.title, residue: markupResidue(l.description ?? '') }))
    .filter((r) => r.residue.length > 0);
  check('no listing description contains markup residue', withMarkup.length === 0,
    withMarkup.length > 0
      ? `${withMarkup.length} do, e.g. "${withMarkup[0]?.title}" (${withMarkup[0]?.residue.join(', ')})`
      : '');

  const longest = listings.reduce((max, l) => Math.max(max, (l.description ?? '').length), 0);
  console.log(`  longest description: ${longest.toLocaleString()} chars`);

  const zeroComp = listings.filter((l) => l.compRaw !== null && /\$0\b/.test(l.compRaw));
  check('no listing reports $0 compensation', zeroComp.length === 0);

  check('every listing has a title and url',
    listings.every((l) => l.title.length > 0 && l.url.length > 0));

  const hashes = listings.map(dedupeHash);
  const unique = new Set(hashes).size;
  console.log(`  ${unique} unique hashes across ${listings.length} listings`);
  check('hashes are deterministic on a second pass',
    listings.map(dedupeHash).every((h, i) => h === hashes[i]));

  const stated = listings.filter((l) => l.compRaw !== null).length;
  const located = listings.filter((l) => l.location !== null).length;
  console.log(
    `  comp stated: ${stated}/${listings.length} · location field set: ${located}/${listings.length}`,
  );
  console.log('  (both are usually sparse — the scorer must read the body, not the fields)');

  const sample = listings[0];
  if (sample) {
    console.log('\n  sample listing');
    console.log(`    ${sample.company ?? '(no company)'} — ${sample.title}`);
    console.log(`    comp=${sample.compRaw ?? 'null'} location=${sample.location ?? 'null'}`);
    console.log(`    posted=${sample.postedAt?.toISOString() ?? 'null'}`);
    console.log(`    ${(sample.description ?? '').slice(0, 160).replace(/\n/g, ' ')}...`);
  }
}

async function main(): Promise<void> {
  companyNormalisation();
  titleNormalisation();
  hashing();
  htmlStripping();
  await liveFeed();

  console.log('');
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('All ingest checks passed. Database-level dedupe needs credentials:');
  console.log('  npx tsx scripts/verify-dedupe.ts');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
