/**
 * worker/sources/detect.ts
 *
 * Turns "here are 200 company names" into a populated watchlist.
 *
 * Every ATS feed is per-company and none is searchable — you cannot ask Ashby for
 * "remote design roles", only for "Ramp's openings". So nothing in the ATS half of
 * the pipeline works until the watchlist exists, and filling it by hand is the
 * actual bottleneck. This resolves a company name or careers URL to
 * {vendor, token} by probing each vendor's public endpoint.
 *
 * Run once per company and store the result. Never on an ingest run.
 *
 * Response shapes below were measured on 2026-09-12, not assumed:
 *   greenhouse  {jobs:[]}                      vercel 86, stripe 635
 *   lever       bare array                     gopuff 780; lever/mistral 200 with 0
 *   ashby       {jobs:[]}                      Ramp 145, Notion 127, Vanta 105
 *   workable    {name, description, jobs:[]}   doist 200 with 0 open
 *   breezy      bare array                     breezy 3
 *   recruitee   {offers:[]}                    timedoctor 4, multiplier 1
 *
 * All six confirmed against live boards. Recruitee took two attempts: the first
 * three tokens tried were 404s, which looked like a wrong response shape and was
 * really just three wrong guesses.
 */

import type { AtsVendor } from './watchlist.js';

export type Detected = {
  company: string;
  vendor: DetectVendor;
  token: string;
  jobCount: number;
};

/** Vendors detection can recognise, including ones with no adapter yet. */
export type DetectVendor = AtsVendor | 'recruitee' | 'breezy';

/** Vendors this codebase can actually ingest from. */
export const INGESTABLE: readonly DetectVendor[] = ['greenhouse', 'lever', 'ashby'];

/** "Acme Labs, Inc." -> ["acmelabs", "acme-labs", "acme"] */
export function candidateSlugs(company: string): string[] {
  const cleaned = company
    .toLowerCase()
    .replace(/\b(?:inc|llc|ltd|limited|corp|corporation|gmbh|bv|nv|plc|co|sa|ab|oy)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  const joined = words.join('');
  const hyphen = words.join('-');
  const first = words[0] ?? '';
  return [...new Set([joined, hyphen, first])].filter((s) => s.length > 1);
}

type Probe = {
  vendor: DetectVendor;
  url: (token: string) => string;
  /**
   * Returns null when the shape is wrong, meaning "this vendor does not know this
   * token" — which is NOT the same as 0, meaning "the board exists and has nothing
   * open today". Two of the Lever boards probed returned 200 with an empty array,
   * and a real but quiet board still belongs on the watchlist.
   */
  count: (body: unknown) => number | null;
};

const arrayLength = (b: unknown): number | null => (Array.isArray(b) ? b.length : null);
const jobsLength = (b: unknown): number | null => {
  const jobs = (b as { jobs?: unknown } | null)?.jobs;
  return Array.isArray(jobs) ? jobs.length : null;
};

const PROBES: Probe[] = [
  {
    vendor: 'greenhouse',
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
    count: jobsLength,
  },
  { vendor: 'lever', url: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`, count: arrayLength },
  { vendor: 'ashby', url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`, count: jobsLength },
  {
    vendor: 'workable',
    url: (t) => `https://apply.workable.com/api/v1/widget/accounts/${t}`,
    count: jobsLength,
  },
  { vendor: 'breezy', url: (t) => `https://${t}.breezy.hr/json`, count: arrayLength },
  {
    vendor: 'recruitee',
    url: (t) => `https://${t}.recruitee.com/api/offers/`,
    count: (b: unknown) => {
      const offers = (b as { offers?: unknown } | null)?.offers;
      return Array.isArray(offers) ? offers.length : null;
    },
  },
];

/** If a careers URL is already known, parse it instead of probing. */
export function detectFromUrl(url: string): { vendor: DetectVendor; token: string } | null {
  const patterns: [DetectVendor, RegExp][] = [
    ['greenhouse', /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/i],
    ['lever', /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i],
    ['ashby', /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i],
    ['workable', /(?:apply\.workable\.com\/([a-z0-9_-]+)|([a-z0-9-]+)\.workable\.com)/i],
    ['recruitee', /([a-z0-9-]+)\.recruitee\.com/i],
    ['breezy', /([a-z0-9-]+)\.breezy\.hr/i],
  ];
  for (const [vendor, re] of patterns) {
    const m = re.exec(url);
    const token = m?.[1] ?? m?.[2];
    if (token !== undefined) return { vendor, token: token.toLowerCase() };
  }
  return null;
}

async function probeOne(p: Probe, token: string, timeoutMs: number): Promise<number | null> {
  try {
    const res = await globalThis.fetch(p.url(token), {
      headers: { accept: 'application/json', 'user-agent': 'job-scraper/0.1 (personal job search)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    // Breezy serves an HTML error page with a 404, and some hosts serve HTML on a
    // 200. Without this check, JSON.parse throws and the probe looks like a miss
    // for the wrong reason.
    if (!(res.headers.get('content-type') ?? '').includes('json')) return null;
    return p.count(await res.json());
  } catch {
    return null;
  }
}

/**
 * Probes vendor/slug combinations and returns the best hit — most jobs wins,
 * because a wrong-but-valid slug belonging to a different company with a similar
 * name usually has fewer.
 *
 * This is a heuristic, not an oracle. Review the output before it reaches the
 * watchlist: a confident match on the wrong company would send applications to
 * a company you never chose.
 */
export async function detectAts(
  company: string,
  opts: { careersUrl?: string; delayMs?: number; timeoutMs?: number } = {},
): Promise<Detected | null> {
  const { careersUrl, delayMs = 250, timeoutMs = 12_000 } = opts;

  if (careersUrl !== undefined) {
    const direct = detectFromUrl(careersUrl);
    if (direct !== null) {
      const probe = PROBES.find((x) => x.vendor === direct.vendor);
      if (probe !== undefined) {
        const n = await probeOne(probe, direct.token, timeoutMs);
        if (n !== null) return { company, vendor: direct.vendor, token: direct.token, jobCount: n };
      }
    }
  }

  const slugs = candidateSlugs(company);
  let best: Detected | null = null;

  for (const probe of PROBES) {
    for (const slug of slugs) {
      const n = await probeOne(probe, slug, timeoutMs);
      if (n !== null && (best === null || n > best.jobCount)) {
        best = { company, vendor: probe.vendor, token: slug, jobCount: n };
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
    // A vendor hit with real openings is good enough; stop probing the rest.
    if (best !== null && best.jobCount > 0) break;
  }
  return best;
}

/** Batch detection. Writes nothing — returns results for review. */
export async function detectMany(
  companies: { company: string; careersUrl?: string }[],
): Promise<{ found: Detected[]; unresolved: string[] }> {
  const found: Detected[] = [];
  const unresolved: string[] = [];

  for (const c of companies) {
    const hit = await detectAts(c.company, c.careersUrl === undefined ? {} : { careersUrl: c.careersUrl });
    if (hit === null) {
      unresolved.push(c.company);
      console.log(`  ..  ${c.company}`);
    } else {
      found.push(hit);
      const usable = INGESTABLE.includes(hit.vendor) ? '' : '  (no adapter yet)';
      console.log(`  ok  ${c.company} -> ${hit.vendor}/${hit.token} (${hit.jobCount} jobs)${usable}`);
    }
  }
  return { found, unresolved };
}
