/**
 * worker/resolve/index.ts
 *
 * Classifies how an application can be submitted, per spec 5.2.
 *
 *   ATS board URL          -> 'ats'    (manual queue in v1; see instructions 3.3)
 *   mailto: or an address  -> 'email'  (the only automated channel)
 *   anything else          -> 'form'   (manual queue)
 *   fetch failed           -> 'unresolved' (manual queue, error recorded)
 *
 * Two shortcuts mean most rows need no HTTP request at all:
 *
 *   - Greenhouse-sourced rows already carry a job-boards.greenhouse.io URL, so the
 *     pattern match answers the question outright.
 *   - RemoteOK's outbound apply link is deliberately not machine-readable. The
 *     /l/<id> endpoint serves an interstitial that assembles the destination from
 *     an obfuscated 700-character token in JavaScript. That is an anti-automation
 *     measure, and reversing it is the same line the project declines to cross for
 *     LinkedIn and Upwork, so these classify as 'form' without being fetched.
 *
 * A resolver pass also discovers which ATS each company uses, which is how the
 * watchlist grows from employers who demonstrably post remotely rather than from a
 * list of well-known names. Discoveries are written to company_watchlist with
 * active = false, so nothing is polled until it is switched on deliberately.
 */

import { db, selectAllRowsWhere } from '../lib/db.js';
import { matchAts, isPlausibleApplicationEmail, scoreApplicationEmail } from './patterns.js';
import type { AtsVendor } from './patterns.js';

export type ApplyMethod = 'email' | 'ats' | 'form' | 'unresolved';

export type Resolution = {
  method: ApplyMethod;
  target: string | null;
  vendor: AtsVendor | null;
  boardToken: string | null;
  /** Why this classification, for the log and the dashboard. */
  note: string;
};

type NewRow = {
  id: string;
  url: string;
  company: string | null;
  source: string;
  /** Set at ingest by sources that publish one. Recruitee is the only one. */
  apply_method: string | null;
  apply_target: string | null;
};

const USER_AGENT = 'Mozilla/5.0 (compatible; job-scraper/0.1; personal job search)';
const FETCH_TIMEOUT_MS = 25_000;
/** One request per host at a time, spaced. Nothing here is urgent. */
const POLITENESS_DELAY_MS = 1_200;

/**
 * Aggregators whose apply destination is deliberately obscured. Listing them is
 * cheaper and more honest than fetching a page in order to fail to parse it.
 */
const OPAQUE_AGGREGATORS: { host: RegExp; note: string }[] = [
  {
    host: /(?:^|\.)remoteok\.com$/i,
    note: 'RemoteOK obfuscates the outbound apply link in JavaScript; not machine-readable by design',
  },
  {
    host: /(?:^|\.)weworkremotely\.com$/i,
    note: 'We Work Remotely returns 403 to non-browser agents; the RSS feed is the sanctioned interface',
  },
  {
    host: /(?:^|\.)himalayas\.app$/i,
    note: 'Himalayas returns 403 to non-browser agents; the JSON API is the sanctioned interface',
  },
];

/**
 * All three aggregators keep the employer's apply path behind their own page — by
 * obfuscation on RemoteOK, by a 403 on the other two. That is their business model:
 * the outbound click is the product. Their feeds are the interface they publish for
 * machines, and those work; the HTML pages are for people, and spoofing a browser
 * user agent to read them anyway would be evading an access control rather than
 * using a public API.
 *
 * The practical consequence is that aggregator listings are always 'form', which is
 * what spec 5.2's "anything else" row prescribes. Listing the hosts here rather
 * than discovering it per row matters: 225 rows each cost a failing request and a
 * politeness delay, which turned one ingest run into seven minutes for nothing.
 */

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Pulls an application address out of a page, or null.
 *
 * mailto: links only. Spec 5.2 says "an email in the apply block", and scanning
 * the whole body is not that — a large company's careers page carries a general
 * enquiries mailbox in its footer, and treating that as an apply path produced 166
 * Stripe rows aimed at careers@stripe.com, which accepts no applications at all.
 * A small company that genuinely wants applications by email publishes a mailto:.
 * Missing a rare address is cheap; the row goes to the manual queue and a human
 * looks at it. Sending to the wrong mailbox costs an application slot and reads as
 * careless.
 */
export function extractEmail(html: string): string | null {
  const candidates = new Set<string>();

  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const address = m[1];
    if (address !== undefined) candidates.add(decodeURIComponent(address).toLowerCase());
  }

  const viable = [...candidates].filter(isPlausibleApplicationEmail);
  if (viable.length === 0) return null;

  viable.sort((a, b) => scoreApplicationEmail(b) - scoreApplicationEmail(a) || a.localeCompare(b));
  return viable[0] ?? null;
}

function fromAtsUrl(url: string): Resolution | null {
  const ats = matchAts(url);
  if (ats === null) return null;
  return {
    method: 'ats',
    target: url,
    vendor: ats.vendor,
    boardToken: ats.boardToken,
    note: `${ats.vendor} board URL`,
  };
}

async function resolveByFetch(url: string): Promise<Resolution> {
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { method: 'unresolved', target: null, vendor: null, boardToken: null, note: `fetch failed: ${message}` };
  }

  // Boards route through trackers, so the destination only appears after redirects.
  const finalUrl = response.url === '' ? url : response.url;
  const viaFinalUrl = fromAtsUrl(finalUrl);
  if (viaFinalUrl !== null) {
    return { ...viaFinalUrl, note: `${viaFinalUrl.note} after redirect` };
  }

  if (!response.ok) {
    return {
      method: 'unresolved',
      target: null,
      vendor: null,
      boardToken: null,
      note: `${response.status} ${response.statusText}`,
    };
  }

  const html = await response.text();

  // An ATS link can sit inside the page rather than in the final URL.
  for (const m of html.matchAll(/https?:\/\/[^"'\s<>]+/gi)) {
    const candidate = fromAtsUrl(m[0]);
    if (candidate !== null) return { ...candidate, note: `${candidate.note} found in page` };
  }

  const email = extractEmail(html);
  if (email !== null) {
    return { method: 'email', target: email, vendor: null, boardToken: null, note: 'address on the apply page' };
  }

  return { method: 'form', target: null, vendor: null, boardToken: null, note: 'no ATS link or address found' };
}

/**
 * Vendors we ingest from directly. A row that came from one of these adapters is
 * on that ATS by definition, whatever its URL looks like, and the board token is
 * already known from the watchlist — so there is nothing to discover and no reason
 * to fetch. This is what stops a custom careers-site URL being mistaken for
 * something else.
 */
const SOURCE_IS_ATS: Record<string, AtsVendor> = { greenhouse: 'greenhouse' };

export async function resolveUrl(
  url: string,
  cache: Map<string, Resolution>,
  source?: string,
): Promise<{ resolution: Resolution; fetched: boolean }> {
  const sourceVendor = source === undefined ? undefined : SOURCE_IS_ATS[source];
  if (sourceVendor !== undefined) {
    const matched = matchAts(url);
    return {
      resolution: {
        method: 'ats',
        target: null, // the board URL is already in the url column
        vendor: sourceVendor,
        boardToken: matched?.boardToken || null,
        note: `ingested from the ${sourceVendor} adapter`,
      },
      fetched: false,
    };
  }

  const direct = fromAtsUrl(url);
  if (direct !== null) return { resolution: { ...direct, target: null }, fetched: false };

  const host = hostOf(url);
  if (host === null) {
    return {
      resolution: { method: 'unresolved', target: null, vendor: null, boardToken: null, note: 'unparseable url' },
      fetched: false,
    };
  }

  for (const aggregator of OPAQUE_AGGREGATORS) {
    if (aggregator.host.test(host)) {
      return {
        resolution: { method: 'form', target: null, vendor: null, boardToken: null, note: aggregator.note },
        fetched: false,
      };
    }
  }

  // One company posts many roles through the same ATS, so the host answer is
  // reusable within a run.
  const cached = cache.get(host);
  if (cached !== undefined && cached.method !== 'email') {
    return { resolution: { ...cached, note: `${cached.note} (cached for ${host})` }, fetched: false };
  }

  const resolution = await resolveByFetch(url);
  if (resolution.method === 'ats' || resolution.method === 'form') cache.set(host, resolution);
  return { resolution, fetched: true };
}

export type ResolveStats = {
  considered: number;
  fetched: number;
  byMethod: Record<ApplyMethod, number>;
  discoveredBoards: number;
};

/** Records a newly seen ATS board, switched off until someone opts in. */
async function recordDiscoveredBoard(
  company: string | null,
  vendor: AtsVendor,
  boardToken: string,
): Promise<boolean> {
  const { data, error } = await db()
    .from('company_watchlist')
    .upsert(
      {
        company: company ?? boardToken,
        ats_vendor: vendor,
        board_token: boardToken,
        active: false,
        notes: 'discovered by the resolver; set active = true to start polling',
      },
      { onConflict: 'ats_vendor,board_token', ignoreDuplicates: true },
    )
    .select('id');

  if (error) {
    console.error(`  could not record board ${vendor}/${boardToken}: ${error.message}`);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

export async function runResolve(limit?: number): Promise<ResolveStats> {
  // Picks up whatever sits in 'new'. A run cancelled halfway leaves the rest in
  // 'new' and the next pass continues from there.
  const rows = await selectAllRowsWhere<NewRow>(
    'opportunities',
    'id, url, company, source, apply_method, apply_target',
    'status',
    'new',
  );
  const pending = rows.slice(0, limit ?? rows.length);

  // Paging is only stable under a total order, so assert it rather than trust it.
  // A silent skip here means a listing never gets scored and never gets applied to,
  // and nothing anywhere reports a problem.
  const distinctIds = new Set(pending.map((r) => r.id)).size;
  if (distinctIds !== pending.length) {
    throw new Error(
      `paging returned ${pending.length} rows but only ${distinctIds} distinct ids — ` +
        'the queue read is not stable and rows are being seen twice.',
    );
  }

  const stats: ResolveStats = {
    considered: 0,
    fetched: 0,
    byMethod: { email: 0, ats: 0, form: 0, unresolved: 0 },
    discoveredBoards: 0,
  };
  const cache = new Map<string, Resolution>();

  /**
   * Writes are grouped rather than issued per row. Updating one row at a time cost
   * a round trip each, and with a board upsert alongside it that was ~2,600 round
   * trips for 1,392 rows — over ten minutes, most of it latency. Rows sharing an
   * identical outcome can be updated in one statement, and the overwhelming
   * majority do share one.
   */
  const groups = new Map<string, { resolution: Resolution; ids: string[] }>();
  const boards = new Map<string, { company: string | null; vendor: AtsVendor; token: string }>();

  for (const row of pending) {
    // A source that published an application address has already answered the
    // question this stage exists to answer. Re-deriving it would mean fetching a
    // page that does not contain it.
    const { resolution, fetched } =
      row.apply_method === 'email' && row.apply_target !== null
        ? {
            resolution: {
              method: 'email' as const,
              target: row.apply_target,
              vendor: null,
              boardToken: null,
              note: `application mailbox published by ${row.source}`,
            },
            fetched: false,
          }
        : await resolveUrl(row.url, cache, row.source);
    stats.considered += 1;
    stats.byMethod[resolution.method] += 1;
    if (fetched) stats.fetched += 1;

    const key = [resolution.method, resolution.vendor, resolution.target, resolution.note].join(' ');
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { resolution, ids: [row.id] });
    else group.ids.push(row.id);

    // Eight boards, not 1,293 upserts: collapse by vendor and token first.
    if (resolution.vendor !== null && resolution.boardToken !== null && resolution.boardToken !== '') {
      const boardKey = `${resolution.vendor}:${resolution.boardToken}`;
      if (!boards.has(boardKey)) {
        boards.set(boardKey, { company: row.company, vendor: resolution.vendor, token: resolution.boardToken });
      }
    }

    // Only sleep when a request actually went out.
    if (fetched) await new Promise((r) => setTimeout(r, POLITENESS_DELAY_MS));
  }

  // PostgREST puts `in` lists in the query string, so chunk to keep URLs sane.
  const CHUNK = 200;
  for (const { resolution, ids } of groups.values()) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { error } = await db()
        .from('opportunities')
        .update({
          apply_method: resolution.method,
          apply_target: resolution.target,
          ats_vendor: resolution.vendor,
          status: 'resolved',
          error: resolution.method === 'unresolved' ? resolution.note : null,
        })
        .in('id', chunk);
      if (error) console.error(`  update failed for ${chunk.length} rows: ${error.message}`);
    }
  }

  for (const board of boards.values()) {
    const added = await recordDiscoveredBoard(board.company, board.vendor, board.token);
    if (added) stats.discoveredBoards += 1;
  }

  return stats;
}
