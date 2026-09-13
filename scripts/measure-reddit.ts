/**
 * scripts/measure-reddit.ts
 *
 * Answers one question before any Reddit adapter gets built: what share of Reddit
 * hiring posts can actually be applied to automatically?
 *
 *   npm run measure:reddit
 *
 * This matters more than it sounds. Across 2,557 listings from six sources the
 * apply path is 2,224 ATS and 333 form and ZERO email — and email is the only
 * channel a machine can use. Reddit is the first source proposed that might change
 * that. If a good share of posts carry a real address it is the most valuable
 * source in the project; if they mostly say "DM me" it is another manual feed with
 * worse signal than We Work Remotely, which returns 12 worldwide-eligible roles
 * from 31 rows.
 *
 * NO CREDENTIALS NEEDED. The original plan used OAuth against a registered script
 * app, which turned out to be a dead end — the app-creation form is gated behind a
 * CAPTCHA that fails behind a VPN. Reddit also 403s the .json endpoints for
 * non-browser agents.
 *
 * But Reddit publishes Atom feeds at /r/<sub>/new/.rss, and those return 200 with
 * the FULL post body, no auth, no registration. A feed is a reader interface
 * published for machines, so this is the sanctioned path rather than a way around
 * the block — the same distinction that made the aggregators' 403s a stop sign
 * while their feeds stayed fair game.
 *
 * A "DM me" post is NOT automatable. Sending a Reddit direct message means driving
 * a user account, the same platform automation this project declines for LinkedIn
 * and Upwork. Email and DM are counted separately; only email is reachable.
 *
 * Writes nothing, stores nothing, touches no database.
 */

import { isPlausibleApplicationEmail } from '../worker/resolve/patterns.js';

/**
 * Subreddit names are case-insensitive, so designjobs and DesignJobs are one
 * subreddit and two requests.
 */
const DEFAULT_SUBS = ['forhire', 'hiring', 'remotejs', 'designjobs', 'jobbit', 'RemoteJobs'];

/**
 * Override with arguments to re-sample only the subs a previous run could not
 * reach: `npm run measure:reddit -- forhire designjobs`. Reddit refuses often
 * enough that a full pass rarely returns everything, and repeating the subs that
 * already answered just spends the rate limit again.
 */
const SUBS = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const TARGETS = SUBS.length > 0 ? SUBS : DEFAULT_SUBS;

const USER_AGENT = 'job-scraper/0.1 (personal job search; contact u/Designs_laucher)';
/**
 * Reddit 429s hard on the RSS endpoints. Nine seconds was not enough — four of six
 * subreddits were refused in the first run, leaving a sample of three, which is no
 * sample at all. Thirty-five seconds costs three minutes and returns real numbers.
 */
const DELAY_MS = 35_000;

type Post = { title: string; body: string; link: string; author: string; updated: string };

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseFeed(xml: string): Post[] {
  const out: Post[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1] ?? '';
    const pick = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(e)?.[1]?.trim() ?? '';
    const rawContent = /<content type="html">([\s\S]*?)<\/content>/.exec(e)?.[1] ?? '';
    out.push({
      title: decode(pick('title')),
      // Decoded twice: the feed escapes the HTML, and the HTML holds its own entities.
      body: stripTags(decode(decode(rawContent))),
      link: /<link href="([^"]+)"/.exec(e)?.[1] ?? '',
      author: pick('name'),
      updated: pick('updated'),
    });
  }
  return out;
}

/** [HIRING] means an employer. [FOR HIRE] means the poster is the candidate. */
function isEmployerPost(p: Post): boolean {
  const t = p.title.toLowerCase();
  if (/\bfor\s*hire\b/.test(t)) return false;
  return /\bhiring\b|\bwe(?:'re| are) (?:hiring|looking)\b|\bseeking\b|\[\s*h\s*\]/.test(t);
}

function isDesignish(p: Post): boolean {
  const hay = `${p.title} ${p.body}`.toLowerCase();
  return /\b(designer|design|ux|ui|product design|figma|webflow|front[- ]?end|design engineer|branding)\b/.test(hay);
}

/** Real addresses only — asset filenames and noreply boxes do not count. */
function emailsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    const address = m[0].toLowerCase();
    if (isPlausibleApplicationEmail(address)) found.add(address);
  }
  // "name (at) domain (dot) com", common where subs discourage plain addresses.
  for (const m of text.matchAll(
    /[a-z0-9._%+-]+\s*(?:\(at\)|\[at\]|\sat\s)\s*[a-z0-9.-]+\s*(?:\(dot\)|\[dot\]|\sdot\s)\s*[a-z]{2,}/gi,
  )) {
    found.add(m[0].replace(/\s+/g, ' ').toLowerCase());
  }
  return [...found];
}

const DM_ONLY =
  /\b(?:dm|pm|message|msg)\s+me\b|\bsend\s+(?:me\s+)?a\s+(?:dm|pm)\b|\breach\s+out\s+(?:via|by|in)\s+(?:dm|pm|chat)\b|\bmessage\s+me\s+(?:with|for|if)\b/i;

/** Rates quoted in the body — what the compensation floor would judge. */
function ratesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(
    /[$€£]\s?\d[\d,.]*\s*k?\b(?:\s*(?:-|–|to)\s*[$€£]?\s?\d[\d,.]*\s*k?\b)?(?:\s*(?:\/|per\s)\s*(?:hr|hour|day|week|month|year|yr|project|word))?/gi,
  )) {
    const s = m[0].replace(/\s+/g, ' ').trim();
    if (/\d/.test(s)) out.add(s);
  }
  return [...out].slice(0, 3);
}

type Bucket = 'email' | 'dm-only' | 'link-only' | 'nothing';

async function fetchSub(sub: string): Promise<Post[]> {
  const res = await fetch(`https://www.reddit.com/r/${sub}/new/.rss`, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/atom+xml' },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) {
    console.log(`  r/${sub}: rate limited — re-run in a few minutes`);
    return [];
  }
  if (!res.ok) {
    console.log(`  r/${sub}: HTTP ${res.status}`);
    return [];
  }
  return parseFeed(await res.text());
}

async function main(): Promise<void> {
  let fetched = 0;
  let employer = 0;
  const relevant: { post: Post; bucket: Bucket; emails: string[]; rates: string[]; sub: string }[] = [];

  for (const sub of TARGETS) {
    const posts = await fetchSub(sub);
    fetched += posts.length;
    const hiring = posts.filter(isEmployerPost);
    employer += hiring.length;
    const design = hiring.filter(isDesignish);

    for (const post of design) {
      const text = `${post.title}\n${post.body}`;
      const emails = emailsIn(text);
      const bucket: Bucket =
        emails.length > 0
          ? 'email'
          : DM_ONLY.test(text)
            ? 'dm-only'
            : /https?:\/\//.test(post.body)
              ? 'link-only'
              : 'nothing';
      relevant.push({ post, bucket, emails, rates: ratesIn(text), sub });
    }
    console.log(`  r/${sub.padEnd(11)} ${String(posts.length).padStart(3)} posts · ${String(hiring.length).padStart(3)} hiring · ${String(design.length).padStart(3)} design-ish`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const count = (b: Bucket) => relevant.filter((r) => r.bucket === b).length;
  const share = (n: number) => (relevant.length === 0 ? '—' : `${((n / relevant.length) * 100).toFixed(0)}%`);

  console.log(`\n=== ${fetched} posts · ${employer} from employers · ${relevant.length} design-relevant ===`);
  if (relevant.length === 0) {
    console.log('\nNothing design-relevant in this sample. These subs are bursty — re-run at a');
    console.log('different hour before concluding anything.');
    return;
  }

  console.log('\nhow each design-relevant post could be applied to:');
  console.log(`  ${String(count('email')).padStart(4)}  ${share(count('email')).padStart(4)}  email in the post   -> AUTOMATABLE`);
  console.log(`  ${String(count('dm-only')).padStart(4)}  ${share(count('dm-only')).padStart(4)}  Reddit DM only      -> not automatable, same line as LinkedIn`);
  console.log(`  ${String(count('link-only')).padStart(4)}  ${share(count('link-only')).padStart(4)}  external link only  -> manual queue, like every other source`);
  console.log(`  ${String(count('nothing')).padStart(4)}  ${share(count('nothing')).padStart(4)}  no contact found    -> manual queue`);

  const withRate = relevant.filter((r) => r.rates.length > 0);
  console.log(`\n${withRate.length}/${relevant.length} quote a rate (${share(withRate.length)}). comp_raw would be null on`);
  console.log('this source, so every post scores NEUTRAL on compensation — better than a');
  console.log('listing that honestly states $60k. These need extracting, not discarding.');
  for (const r of withRate.slice(0, 8)) {
    console.log(`    ${r.rates.join(' , ').slice(0, 40).padEnd(42)} ${r.post.title.slice(0, 58)}`);
  }

  const automatable = relevant.filter((r) => r.bucket === 'email');
  if (automatable.length > 0) {
    console.log('\nposts with a usable address:');
    for (const r of automatable.slice(0, 12)) {
      console.log(`  ${(r.emails[0] ?? '').padEnd(34)} ${r.post.title.slice(0, 58)}`);
      console.log(`    ${r.post.link}`);
    }
  }

  console.log('\n--- the decision ---');
  const emailShare = count('email') / relevant.length;
  if (emailShare >= 0.25) {
    console.log(`${share(count('email'))} carry a usable address. Worth building — the only source that`);
    console.log('would move the automated channel off zero.');
  } else {
    console.log(`Only ${share(count('email'))} carry a usable address, so most land in the same manual`);
    console.log('queue as everything else. Judge it on coverage against We Work Remotely,');
    console.log('which returns 12 worldwide-eligible roles from 31 rows.');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
