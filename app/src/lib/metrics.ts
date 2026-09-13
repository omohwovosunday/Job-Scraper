/**
 * app/src/lib/metrics.ts
 *
 * The numbers spec §12 asks for from day one: applications sent, reply rate,
 * reply rate by score band, reply rate by case study, and time from a posting
 * being discovered to the application going out.
 *
 * The score-band and case-study breakdowns are the ones that let the threshold
 * move and the noise get cut. Without them you are guessing.
 *
 * Every function here tolerates an empty table, because for the first while it
 * will be empty — nothing has been sent yet. A dashboard that throws on no data
 * is a dashboard nobody sets up early enough to be useful.
 */

import 'server-only';
import { db, selectAll } from './db';

export type Opportunity = {
  id: string;
  source: string;
  company: string | null;
  title: string;
  url: string;
  location: string | null;
  comp_raw: string | null;
  score: number | null;
  score_reason: string | null;
  red_flags: unknown;
  status: string;
  tier: string | null;
  apply_method: string | null;
  resume_variant: string | null;
  case_study_used: string | null;
  discovered_at: string;
  sent_at: string | null;
  replied_at: string | null;
  outcome: string | null;
};

export type RunRow = {
  id: string;
  stage: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  error: string | null;
  stats: Record<string, unknown>;
};

export type AlertRow = {
  id: string;
  alert_key: string;
  severity: string;
  subject: string;
  body: string;
  sent_at: string;
  suppressed_since_last: number;
  delivered: boolean;
  delivery_error: string | null;
};

export function flagsOf(row: { red_flags: unknown }): string[] {
  return Array.isArray(row.red_flags) ? (row.red_flags as string[]) : [];
}

const DAY_MS = 86_400_000;

/** Local-date key, so "today" means the operator's today. */
function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export type DailyRow = { day: string; discovered: number; scored: number; sent: number; replied: number };

/** Activity per day for the last `days` days, including days with nothing. */
export function daily(rows: Opportunity[], days = 14): DailyRow[] {
  const out = new Map<string, DailyRow>();
  const today = Date.now();
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = new Date(today - i * DAY_MS).toISOString().slice(0, 10);
    out.set(key, { day: key, discovered: 0, scored: 0, sent: 0, replied: 0 });
  }

  for (const r of rows) {
    const d = out.get(dayKey(r.discovered_at));
    if (d) {
      d.discovered += 1;
      if (r.score !== null) d.scored += 1;
    }
    if (r.sent_at !== null) {
      const s = out.get(dayKey(r.sent_at));
      if (s) s.sent += 1;
    }
    if (r.replied_at !== null) {
      const p = out.get(dayKey(r.replied_at));
      if (p) p.replied += 1;
    }
  }
  return [...out.values()];
}

export type Rate = { label: string; sent: number; replied: number; rate: number | null };

function rate(label: string, rows: Opportunity[]): Rate {
  const sent = rows.filter((r) => r.sent_at !== null).length;
  const replied = rows.filter((r) => r.replied_at !== null).length;
  return { label, sent, replied, rate: sent === 0 ? null : replied / sent };
}

/**
 * Reply rate by score band. This is what tells you whether the threshold is in
 * the right place: if the 75-84 band replies as often as 85+, the threshold is
 * too high and you are discarding good applications.
 */
export function replyRateByScoreBand(rows: Opportunity[]): Rate[] {
  const bands: [string, (s: number) => boolean][] = [
    ['85-100', (s) => s >= 85],
    ['75-84', (s) => s >= 75 && s < 85],
    ['65-74', (s) => s >= 65 && s < 75],
    ['below 65', (s) => s < 65],
  ];
  return bands.map(([label, test]) => rate(label, rows.filter((r) => r.score !== null && test(r.score))));
}

/** Reply rate by case study — which of the four is actually working. */
export function replyRateByCaseStudy(rows: Opportunity[]): Rate[] {
  const studies = [...new Set(rows.map((r) => r.case_study_used).filter((x): x is string => x !== null))];
  return studies.map((s) => rate(s, rows.filter((r) => r.case_study_used === s)));
}

export function replyRateBySource(rows: Opportunity[]): Rate[] {
  const sources = [...new Set(rows.map((r) => r.source))].sort();
  return sources.map((s) => rate(s, rows.filter((r) => r.source === s)));
}

/**
 * Median hours from discovery to application. The spec asks for it because it is
 * the one number that says whether the speed advantage is real — a posting applied
 * to three days late is competing against a different pile of applications.
 */
export function medianHoursToApply(rows: Opportunity[]): number | null {
  const deltas = rows
    .filter((r) => r.sent_at !== null)
    .map((r) => (new Date(r.sent_at as string).getTime() - new Date(r.discovered_at).getTime()) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  if (deltas.length === 0) return null;
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 === 0 ? (deltas[mid - 1]! + deltas[mid]!) / 2 : deltas[mid]!;
}

export type Health = {
  lastRun: Record<string, RunRow | undefined>;
  staleStages: string[];
  recentFailures: RunRow[];
  openAlerts: AlertRow[];
  suppressedCount: number;
};

/**
 * What is broken right now.
 *
 * The important case is the one a try/catch cannot see: a stage that never starts
 * throws nothing. So this checks the AGE of the newest run, not just whether the
 * last one succeeded. Ingest is on a 20-minute cron; silence for two hours means
 * the cron is not firing.
 */
export async function health(): Promise<Health> {
  // run_log and alert_log arrive in migration 0003. Before it is applied the
  // queries 404, and a dashboard that white-screens because one table is missing
  // is a dashboard nobody gets working. Degrade to "no data" instead.
  let runs: RunRow[] = [];
  try {
    runs = await selectAll<RunRow>(
      'run_log',
      'id, stage, started_at, finished_at, ok, error, stats',
      'started_at',
    );
  } catch {
    return {
      lastRun: {},
      staleStages: ['run_log table not found — apply supabase/migrations/0003_alerts.sql'],
      recentFailures: [],
      openAlerts: [],
      suppressedCount: 0,
    };
  }
  const recent = runs.slice(-400).reverse();

  const lastRun: Record<string, RunRow | undefined> = {};
  for (const r of recent) lastRun[r.stage] ??= r;

  const EXPECTED_INTERVAL_MINUTES: Record<string, number> = { ingest: 120, process: 120 };
  const staleStages: string[] = [];
  for (const [stage, maxAge] of Object.entries(EXPECTED_INTERVAL_MINUTES)) {
    const last = lastRun[stage];
    if (last === undefined) {
      staleStages.push(`${stage} (never run)`);
      continue;
    }
    const ageMinutes = (Date.now() - new Date(last.started_at).getTime()) / 60_000;
    if (ageMinutes > maxAge) {
      staleStages.push(`${stage} (${Math.round(ageMinutes / 60)}h ago)`);
    }
  }

  const { data: alertData } = await db()
    .from('alert_log')
    .select('*')
    .order('sent_at', { ascending: false })
    .limit(50);
  const allAlerts = (alertData ?? []) as AlertRow[];

  return {
    lastRun,
    staleStages,
    recentFailures: recent.filter((r) => r.ok === false).slice(0, 10),
    openAlerts: allAlerts.filter((a) => a.delivered).slice(0, 10),
    suppressedCount: allAlerts.filter((a) => !a.delivered).length,
  };
}

export async function loadOpportunities(): Promise<Opportunity[]> {
  return selectAll<Opportunity>(
    'opportunities',
    'id, source, company, title, url, location, comp_raw, score, score_reason, red_flags, status, tier, apply_method, resume_variant, case_study_used, discovered_at, sent_at, replied_at, outcome',
  );
}

export async function loadSettings(): Promise<Record<string, unknown>> {
  const { data, error } = await db().from('settings').select('key, value');
  if (error) throw new Error(`settings: ${error.message}`);
  return Object.fromEntries((data ?? []).map((r) => [r.key as string, r.value]));
}

// --- Additions adopted from the dashboard mockup -----------------------------

export type Today = {
  sent: number;
  replies: number;
  drafted: number;
  waiting: number;
  expired: number;
  capUsed: number;
  capTotal: number;
};

/** Local-day boundary, so "today" means the operator's today, not UTC's. */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const EXPIRY_DAYS = 14;

/**
 * Today's counters, plus the one the mockup was right to ask for: listings that
 * scored above the threshold and then aged out without anyone applying.
 *
 * That number is the honest measure of whether the queue is being worked. Nothing
 * else on the page says "the pipeline did its job and you did not" — sent stays
 * flat, the queue just grows, and it reads as a quiet backlog rather than a loss.
 */
export function today(rows: Opportunity[], capTotal: number): Today {
  const since = startOfToday();
  const on = (iso: string | null) => iso !== null && new Date(iso).getTime() >= since;
  const expiryCutoff = Date.now() - EXPIRY_DAYS * 86_400_000;

  const sentToday = rows.filter((r) => on(r.sent_at)).length;
  return {
    sent: sentToday,
    replies: rows.filter((r) => on(r.replied_at)).length,
    drafted: rows.filter((r) => r.status === 'drafted' || r.status === 'queued').length,
    waiting: rows.filter((r) => r.status === 'scored' || r.status === 'queued').length,
    expired: rows.filter(
      (r) =>
        r.sent_at === null &&
        (r.status === 'scored' || r.status === 'queued') &&
        new Date(r.discovered_at).getTime() < expiryCutoff,
    ).length,
    capUsed: sentToday,
    capTotal,
  };
}

/**
 * What a failing stage still leaves working. A fault banner that only says
 * "scorer failed" makes you guess whether anything is still moving.
 */
export function faultConsequence(stage: string): string {
  switch (stage) {
    case 'ingest':
      return 'Nothing new is being discovered. Scoring and the queue still work on what is already held.';
    case 'process':
      return 'No new listings are being scored, so the queue stops growing. Discovery continues.';
    case 'outreach':
      return 'Cold outreach is stalled. Job applications are unaffected.';
    case 'followup':
      return 'Follow-ups are stalled. Nothing else is affected.';
    default:
      return 'Other stages are unaffected.';
  }
}
