/**
 * scripts/measure-reddit.ts
 *
 * Answers one question before any Reddit adapter gets built: what share of Reddit
 * hiring posts can actually be applied to automatically?
 *
 *   npm run measure:reddit
 *
 * This matters more than it sounds. Across 2,557 listings from six sources, the
 * apply path is 2,224 ATS and 333 form and ZERO email — and email is the only
 * channel a machine can use. Reddit is the first source anyone has proposed that
 * might change that. If a good share of posts carry a real address, it is the most
 * valuable source in the project. If they mostly say "DM me", it is another manual
 * queue feed with worse signal than We Work Remotely, which costs 31 rows for 12
 * worldwide-eligible roles.
 *
 * A "DM me" post is NOT automatable. Sending a Reddit direct message means driving
 * a user account, which is the same platform automation the project declines for
 * LinkedIn and Upwork. So the two are counted separately and only the email share
 * is treated as reachable.
 *
 * Writes nothing. Reads nothing from the database. Throwaway by design.
 *
 * Credentials: register a "script" app at reddit.com/prefs/apps, then set
 * REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET and REDDIT_USER_AGENT. Reddit requires a
 * descriptive user agent with a contact; a generic one gets blocked.
 */

import { requireString } from '../worker/lib/env.js';
import { isPlausibleApplicationEmail } from '../worker/resolve/patterns.js';

const OAUTH = 'https://www.reddit.com/api/v1/access_token';
const API = 'https://oauth.reddit.com';

/**
 * Subreddit names are case-insensitive, so "designjobs" and "DesignJobs" are one
 * subreddit and two requests. Listed once.
 */
const SUBS = ['forhire', 'hiring', 'remotejs', 'designjobs', 'RemoteJobs', 'jobbit'] as const;

type Post = {
  id: string;
  title: string;
  selftext: string;
  author: string;
  created_utc: number;
  permalink: string;
  link_flair_text: string | null;
  subreddit: string;
  over_18: boolean;
  removed_by_category?: string | null;
};

async function token(): Promise<string> {
  const id = requireString('REDDIT_CLIENT_ID', 'Register a script app at reddit.com/prefs/apps.');
  const secret = requireString('REDDIT_CLIENT_SECRET', 'The secret from that same app.');
  const ua = requireString(
    'REDDIT_USER_AGENT',
    'Reddit requires a descriptive agent with a contact, e.g. "job-scraper/0.1 by u/yourname".',
  );

  const res = await fetch(OAUTH, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': ua,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(
      `Reddit OAuth returned ${res.status}. A 401 usually means the app is not of type "script", ` +
        'or the id and secret are swapped.',
    );
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

/** [HIRING] means an employer. [FOR HIRE] means the poster is the candidate. */
function isEmployerPost(p: Post): boolean {
  const hay = `${p.link_flair_text ?? ''} ${p.title}`.toLowerCase();
  if (/\bfor\s*hire\b/.test(hay)) return false;
  return /\bhiring\b|\bwe(?:'re| are) (?:hiring|looking)\b|\bseeking\b/.test(hay);
}

function isDesignish(p: Post): boolean {
  const hay = `${p.title} ${p.selftext}`.toLowerCase();
  return /\b(designer|design|ux|ui|product design|figma|webflow|front[- ]?end|design engineer)\b/.test(hay);
}

/** Real addresses only — asset filenames and noreply boxes do not count. */
function emailsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    const address = m[0].toLowerCase();
    if (isPlausibleApplicationEmail(address)) found.add(address);
  }
  // "name (at) domain (dot) com" is common where subs discourage plain addresses.
  for (const m of text.matchAll(/[a-z0-9._%+-]+\s*(?:\(at\)|\[at\]|\sat\s)\s*[a-z0-9.-]+\s*(?:\(dot\)|\[dot\]|\sdot\s)\s*[a-z]{2,}/gi)) {
    found.add(m[0].replace(/\s+/g, ' ').toLowerCase());
  }
  return [...found];
}

const DM_ONLY = /\b(dm|pm|message|msg)\s+me\b|\bsend\s+(?:me\s+)?a\s+(?:dm|pm)\b|\breach\s+out\s+(?:via|by)\s+(?:dm|pm|chat)\b/i;

/** Rates quoted in the body — the number the compensation floor would judge. */
function ratesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[$€£]\s?\d[\d,.]*\s*(?:k\b)?(?:\s*(?:-|–|to)\s*[$€£]?\s?\d[\d,.]*\s*k?\b)?(?:\s*(?:\/|per\s)\s*(?:hr|hour|day|week|month|year|yr))?/gi)) {
    const s = m[0].replace(/\s+/g, ' ').trim();
    if (/\d/.test(s)) out.add(s);
  }
  return [...out].slice(0, 3);
}

async function fetchSub(sub: string, bearer: string, ua: string): Promise<Post[]> {
  const res = await fetch(`${API}/r/${sub}/new?limit=100`, {
    headers: { authorization: `Bearer ${bearer}`, 'user-agent': ua },
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 403 || res.status === 404) {
    console.log(`  r/${sub}: unavailable (${res.status})`);
    return [];
  }
  if (res.status === 429) {
    console.log(`  r/${sub}: rate limited`);
    return [];
  }
  if (!res.ok) {
    console.log(`  r/${sub}: HTTP ${res.status}`);
    return [];
  }
  const body = (await res.json()) as { data?: { children?: { data: Post }[] } };
  return (body.data?.children ?? []).map((c) => c.data);
}

type Bucket = 'email' | 'dm-only' | 'link-only' | 'nothing';

async function main(): Promise<void> {
  const ua = requireString('REDDIT_USER_AGENT', 'Required by Reddit.');
  const bearer = await token();

  let fetched = 0;
  let employer = 0;
  const relevant: { post: Post; bucket: Bucket; emails: string[]; rates: string[] }[] = [];

  for (const sub of SUBS) {
    const posts = await fetchSub(sub, bearer, ua);
    fetched += posts.length;
    const live = posts.filter((p) => !p.over_18 && !p.removed_by_category);
    const hiring = live.filter(isEmployerPost);
    employer += hiring.length;
    const design = hiring.filter(isDesignish);

    for (const post of design) {
      const text = `${post.title}\n${post.selftext}`;
      const emails = emailsIn(text);
      const bucket: Bucket =
        emails.length > 0 ? 'email'
        : DM_ONLY.test(text) ? 'dm-only'
        : /https?:\/\//.test(text) ? 'link-only'
        : 'nothing';
      relevant.push({ post, bucket, emails, rates: ratesIn(text) });
    }
    console.log(`  r/${sub}: ${posts.length} posts, ${hiring.length} hiring, ${design.length} design-ish`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  const count = (b: Bucket) => relevant.filter((r) => r.bucket === b).length;
  const share = (n: number) => (relevant.length === 0 ? '—' : `${((n / relevant.length) * 100).toFixed(0)}%`);

  console.log(`\n=== ${fetched} posts fetched · ${employer} from employers · ${relevant.length} design-relevant ===`);
  console.log('\nhow each design-relevant post could be applied to:');
  console.log(`  ${String(count('email')).padStart(4)}  ${share(count('email')).padStart(4)}  email in the post   -> AUTOMATABLE`);
  console.log(`  ${String(count('dm-only')).padStart(4)}  ${share(count('dm-only')).padStart(4)}  Reddit DM only      -> not automatable, same line as LinkedIn`);
  console.log(`  ${String(count('link-only')).padStart(4)}  ${share(count('link-only')).padStart(4)}  external link only  -> manual queue, same as every other source`);
  console.log(`  ${String(count('nothing')).padStart(4)}  ${share(count('nothing')).padStart(4)}  no contact found    -> manual queue`);

  const withRate = relevant.filter((r) => r.rates.length > 0);
  console.log(`\n${withRate.length}/${relevant.length} quote a rate in the body (${share(withRate.length)})`);
  console.log('  These matter: comp_raw is null on this source, so every post would score');
  console.log('  neutral on compensation — better than a listing that honestly states $60k.');
  for (const r of withRate.slice(0, 8)) {
    console.log(`    ${r.rates.join(' , ').slice(0, 46).padEnd(48)} ${r.post.title.slice(0, 60)}`);
  }

  const automatable = relevant.filter((r) => r.bucket === 'email');
  if (automatable.length > 0) {
    console.log('\nposts with a usable address:');
    for (const r of automatable.slice(0, 12)) {
      console.log(`  ${r.emails[0]?.padEnd(32)} ${r.post.title.slice(0, 64)}`);
      console.log(`    https://www.reddit.com${r.post.permalink}`);
    }
  }

  console.log('\n--- the decision ---');
  if (relevant.length === 0) {
    console.log('No design-relevant hiring posts in this sample. Re-run at a different hour');
    console.log('before concluding anything — these subreddits are bursty.');
  } else if (count('email') / relevant.length >= 0.25) {
    console.log(`${share(count('email'))} carry a usable address. That is worth building: it is the only`);
    console.log('source that would move the automated channel off zero.');
  } else {
    console.log(`Only ${share(count('email'))} carry a usable address, so most would land in the same`);
    console.log('manual queue as everything else. Worth adding for coverage, but it does not');
    console.log('change what the system is — judge it against We Work Remotely, which returns');
    console.log('12 worldwide-eligible roles from 31 rows.');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
