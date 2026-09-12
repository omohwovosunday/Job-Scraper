/**
 * scripts/check-resolve.ts
 *
 * Apply-path classification, checked without a database or a network call.
 *
 *   npm run check:resolve
 */

import { matchAts, isPlausibleApplicationEmail } from '../worker/resolve/patterns.js';
import { extractEmail } from '../worker/resolve/index.js';

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

function atsPatterns(): void {
  console.log('\nATS url recognition');

  const cases: [string, string, string][] = [
    // url, expected vendor, expected board token
    ['https://job-boards.greenhouse.io/vercel/jobs/6136160004', 'greenhouse', 'vercel'],
    ['https://boards.greenhouse.io/airtable/jobs/7654321', 'greenhouse', 'airtable'],
    ['https://boards.eu.greenhouse.io/someco/jobs/123', 'greenhouse', 'someco'],
    ['https://jobs.lever.co/matterport/abc-123-def', 'lever', 'matterport'],
    ['https://jobs.ashbyhq.com/openai/4f2b8c1a', 'ashby', 'openai'],
    ['https://apply.workable.com/acme/j/A1B2C3D4E5', 'workable', 'acme'],
    ['https://acme.workable.com/j/A1B2C3D4E5', 'workable', 'acme'],
  ];
  for (const [url, vendor, token] of cases) {
    const m = matchAts(url);
    check(`${vendor.padEnd(10)} ${url.slice(8, 52)}`,
      m !== null && m.vendor === vendor && m.boardToken === token,
      m === null ? 'no match' : `got ${m.vendor}/${m.boardToken}`);
  }

  console.log('\n  things that must NOT match');
  for (const url of [
    'https://remoteok.com/remote-jobs/remote-product-designer-acme-123456',
    'https://acme.com/careers/product-designer',
    'https://www.linkedin.com/jobs/view/123456',
    'not a url at all',
    'https://greenhouse.io',
  ]) {
    check(`${url.slice(0, 56)}`, matchAts(url) === null,
      matchAts(url) !== null ? `matched ${matchAts(url)?.vendor}` : '');
  }

  // The board token is what company_watchlist needs, so a wrong capture would
  // silently seed an unpollable board.
  const gh = matchAts('https://job-boards.greenhouse.io/remotecom/jobs/1234');
  check('board token is the org slug, not the posting id',
    gh?.boardToken === 'remotecom' && gh?.postingId === '1234',
    JSON.stringify(gh));
}

function customCareerSiteUrls(): void {
  console.log('\ncustom careers-site urls fronting an ATS');

  // Regression: Stripe publishes Greenhouse jobs on its own domain. Missing this
  // sent 166 rows to careers@stripe.com, which accepts no applications.
  const stripe = matchAts("https://stripe.com/jobs/search?gh_jid=7974209");
  check("gh_jid on a non-greenhouse host is recognised as greenhouse",
    stripe !== null && stripe.vendor === "greenhouse" && stripe.postingId === "7974209",
    JSON.stringify(stripe));

  check("a non-numeric gh_jid is not trusted",
    matchAts("https://acme.com/jobs?gh_jid=not-a-number") === null);
  check("an unrelated query string is not a match",
    matchAts("https://acme.com/careers?ref=twitter") === null);
}

function emailSelection(): void {
  console.log('\nemail selection');

  check('careers mailbox is preferred over a generic one',
    extractEmail('<a href="mailto:privacy@acme.com">privacy</a><a href="mailto:careers@acme.com">apply</a>')
      === 'careers@acme.com');

  check('jobs@ beats hello@',
    extractEmail('<a href="mailto:hello@acme.com">x</a><a href="mailto:jobs@acme.com">y</a>')
      === 'jobs@acme.com');

  // Sending an application to one of these wastes a slot and reads as careless.
  for (const bad of ['noreply@acme.com', 'privacy@acme.com', 'legal@acme.com',
                     'postmaster@acme.com', 'support@acme.com', 'sprite@2x.png']) {
    check(`rejected: ${bad}`, !isPlausibleApplicationEmail(bad));
  }
  for (const good of ['careers@acme.com', 'apply@acme.co.uk', 'jobs+design@acme.com',
                      'hello@acme.com', 'talent@acme.io']) {
    check(`accepted: ${good}`, isPlausibleApplicationEmail(good));
  }

  // A general careers-page footer mailbox is not an apply path. Only mailto:
  // counts, so a bare address in body text must be ignored. This is the other
  // half of the Stripe regression.
  check('a bare address in body text is ignored',
    extractEmail('<p>Questions? careers@stripe.com</p>') === null,
    JSON.stringify(extractEmail('<p>Questions? careers@stripe.com</p>')));
  check('a bare address in a footer is ignored',
    extractEmail('<footer>hello@acme.com</footer>') === null);

  check('a page with only rejected addresses yields null',
    extractEmail('<a href="mailto:noreply@acme.com">x</a> privacy@acme.com') === null);

  check('mailto: wins over a bare address elsewhere on the page',
    extractEmail('contact random@other.com <a href="mailto:careers@acme.com">apply</a>')
      === 'careers@acme.com');

  check('url-encoded mailto is decoded',
    extractEmail('<a href="mailto:careers%40acme.com">apply</a>') === 'careers@acme.com');

  check('no address at all yields null', extractEmail('<p>Apply on our site.</p>') === null);
}

function main(): void {
  atsPatterns();
  customCareerSiteUrls();
  emailSelection();

  console.log('');
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('All resolver checks passed.');
}

main();
