/**
 * worker/resolve/patterns.ts
 *
 * Recognising an applicant-tracking system from a URL.
 *
 * Matching the URL is worth doing before fetching anything. Greenhouse-sourced
 * rows already carry a job-boards.greenhouse.io link, so 1,293 of the 1,392 rows
 * currently in the table classify with no HTTP request at all. Only the aggregator
 * listings, whose URLs point back at the aggregator, need following.
 *
 * The board token is captured because it is what company_watchlist needs. A
 * resolver run therefore discovers which companies use which ATS, which is how the
 * watchlist grows from employers who demonstrably post remotely rather than from a
 * list of famous names.
 */

export type AtsVendor = 'greenhouse' | 'lever' | 'ashby' | 'workable';

export type AtsMatch = {
  vendor: AtsVendor;
  /** The org slug in the board URL — the board_token for that vendor's API. */
  boardToken: string;
  /** The vendor's own id for the posting, where the URL carries one. */
  postingId: string | null;
};

type Pattern = {
  vendor: AtsVendor;
  /** Matched against `host + pathname`, lowercased. */
  re: RegExp;
  /** Which capture group holds the board token, and which the posting id. */
  tokenGroup: number;
  postingGroup: number | null;
};

const PATTERNS: Pattern[] = [
  // Greenhouse serves boards on two hosts. job-boards is what the API returns
  // today; boards.greenhouse.io is the older form and still widely linked.
  {
    vendor: 'greenhouse',
    re: /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/,
    tokenGroup: 1,
    postingGroup: 2,
  },
  {
    vendor: 'greenhouse',
    re: /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([^/]+)\/?$/,
    tokenGroup: 1,
    postingGroup: null,
  },
  // Greenhouse-hosted application form reached through an embed.
  {
    vendor: 'greenhouse',
    re: /^boards\.greenhouse\.io\/embed\/job_app\?token=(\d+)/,
    tokenGroup: 1,
    postingGroup: null,
  },
  {
    vendor: 'lever',
    re: /^jobs(?:\.eu)?\.lever\.co\/([^/]+)(?:\/([0-9a-f-]+))?/,
    tokenGroup: 1,
    postingGroup: 2,
  },
  {
    vendor: 'ashby',
    re: /^jobs\.ashbyhq\.com\/([^/]+)(?:\/([0-9a-f-]+))?/,
    tokenGroup: 1,
    postingGroup: 2,
  },
  // Workable uses both a per-company subdomain and a shared apply host.
  {
    vendor: 'workable',
    re: /^apply\.workable\.com\/([^/]+)\/j\/([0-9a-z]+)/,
    tokenGroup: 1,
    postingGroup: 2,
  },
  {
    vendor: 'workable',
    re: /^([a-z0-9-]+)\.workable\.com\/j\/([0-9a-z]+)/,
    tokenGroup: 1,
    postingGroup: 2,
  },
];

export function matchAts(rawUrl: string): AtsMatch | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const subject = `${parsed.host}${parsed.pathname}`.toLowerCase();

  for (const pattern of PATTERNS) {
    const m = pattern.re.exec(subject);
    if (m === null) continue;

    const boardToken = m[pattern.tokenGroup];
    if (boardToken === undefined || boardToken.length === 0) continue;

    const postingId =
      pattern.postingGroup === null ? null : (m[pattern.postingGroup] ?? null);
    return { vendor: pattern.vendor, boardToken, postingId };
  }

  // The embed form carries the token in the query string, not the path.
  if (/^boards\.greenhouse\.io\/embed\/job_app$/.test(subject)) {
    const token = parsed.searchParams.get('token');
    if (token !== null) {
      return { vendor: 'greenhouse', boardToken: token, postingId: token };
    }
  }

  /**
   * Companies front Greenhouse with their own careers site, so the URL carries no
   * greenhouse.io host at all — Stripe publishes
   * https://stripe.com/jobs/search?gh_jid=7974209. The gh_jid parameter IS the
   * Greenhouse job id and is the reliable marker.
   *
   * Getting this wrong is expensive: 166 Stripe rows classified as 'email' against
   * careers@stripe.com, a general enquiries mailbox that accepts no applications.
   * The board token cannot be recovered from the URL, so it is left null and the
   * caller supplies it from the source that produced the row.
   */
  const ghJid = parsed.searchParams.get('gh_jid');
  if (ghJid !== null && /^\d+$/.test(ghJid)) {
    return { vendor: 'greenhouse', boardToken: '', postingId: ghJid };
  }
  return null;
}

/**
 * Addresses that appear on careers pages but are not where an application goes.
 * Sending a cover letter to privacy@ or noreply@ wastes an application slot and
 * looks careless, so an address matching any of these is never chosen.
 */
const NON_APPLICATION_MAILBOXES =
  /^(?:no-?reply|donotreply|privacy|legal|dpo|gdpr|abuse|postmaster|webmaster|security|press|media|marketing|sales|billing|invoices?|accounts?|support|help|helpdesk|admin|webadmin|unsubscribe)(?:[.+-]|$)/i;

/** Asset filenames routinely parse as addresses — sprite@2x.png and friends. */
const ASSET_LOOKALIKE = /\.(?:png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico)$/i;

export function isPlausibleApplicationEmail(address: string): boolean {
  const at = address.indexOf('@');
  if (at <= 0) return false;

  const local = address.slice(0, at);
  const domain = address.slice(at + 1);

  if (ASSET_LOOKALIKE.test(address)) return false;
  if (NON_APPLICATION_MAILBOXES.test(local)) return false;
  if (!domain.includes('.')) return false;
  if (/\.(?:png|jpe?g|gif|svg|webp)$/i.test(domain)) return false;
  // Sentry and similar embed keys that look like addresses.
  if (/sentry\.io$/i.test(domain)) return false;
  return true;
}

/** Ranks candidate addresses so an explicit careers mailbox wins. */
export function scoreApplicationEmail(address: string): number {
  const local = address.slice(0, address.indexOf('@')).toLowerCase();
  if (/^(?:apply|applications?|jobs?|careers?|recruiting|recruitment|hiring|talent)(?:[.+-]|$)/.test(local)) {
    return 3;
  }
  if (/(?:apply|job|career|recruit|hiring|talent|hr)/.test(local)) return 2;
  return 1;
}
