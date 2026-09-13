/**
 * worker/lib/alerts.ts
 *
 * Operational alerting: run failures, cap hits, replies received (spec §8).
 *
 * Two design points that matter more than the sending.
 *
 * THROTTLING. The cron fires 72 times a day. A stage that breaks and stays broken
 * would send 72 identical emails, which is how people learn to ignore alerts. Each
 * alert has a stable key and a cooldown; repeats inside the window are recorded
 * with a suppression count and not sent. The next email that does go out says how
 * many it stood in for.
 *
 * FAILING QUIETLY. An alert that throws takes down the stage it was reporting on,
 * turning a recoverable problem into a lost run. Nothing here throws: delivery
 * failures are written to alert_log and logged.
 *
 * Transport is Gmail for now. SETUP §4 puts the `system` sender on ZeptoMail,
 * which needs a verified domain that does not exist yet. Alerts go to the owner
 * rather than to strangers, so deliverability reputation is not the concern it is
 * for the other two senders, and Gmail is already verified working.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { db } from './db.js';
import { optionalString, requireString } from './env.js';

export type Severity = 'info' | 'warn' | 'error';

export type Alert = {
  /** Stable identity for a recurring condition — no timestamps, no row ids. */
  key: string;
  severity: Severity;
  subject: string;
  body: string;
};

const DEFAULT_COOLDOWN_MINUTES = 120;

type AlertSettings = { enabled: boolean; cooldownMinutes: number };

async function alertSettings(): Promise<AlertSettings> {
  const { data, error } = await db()
    .from('settings')
    .select('key, value')
    .in('key', ['alerts_enabled', 'alert_cooldown_minutes']);
  if (error) return { enabled: true, cooldownMinutes: DEFAULT_COOLDOWN_MINUTES };

  const raw = new Map((data ?? []).map((r) => [r.key as string, r.value]));
  const enabled = raw.get('alerts_enabled');
  const cooldown = raw.get('alert_cooldown_minutes');
  return {
    enabled: typeof enabled === 'boolean' ? enabled : true,
    cooldownMinutes:
      typeof cooldown === 'number' && Number.isFinite(cooldown) ? cooldown : DEFAULT_COOLDOWN_MINUTES,
  };
}

/** Most recent send for this key, and how many have been suppressed since. */
async function lastSend(key: string): Promise<{ sentAt: Date; suppressed: number } | null> {
  const { data, error } = await db()
    .from('alert_log')
    .select('sent_at, suppressed_since_last, delivered')
    .eq('alert_key', key)
    .eq('delivered', true)
    .order('sent_at', { ascending: false })
    .limit(1);
  if (error || data === null || data.length === 0) return null;

  const row = data[0] as { sent_at: string; suppressed_since_last: number };
  return { sentAt: new Date(row.sent_at), suppressed: row.suppressed_since_last };
}

async function countSuppressedSince(key: string, since: Date): Promise<number> {
  const { count } = await db()
    .from('alert_log')
    .select('*', { count: 'exact', head: true })
    .eq('alert_key', key)
    .eq('delivered', false)
    .gte('sent_at', since.toISOString());
  return count ?? 0;
}

let transport: Transporter | undefined;

function gmailTransport(): Transporter {
  if (transport) return transport;
  const user = requireString('GMAIL_USER', 'Required to send operational alerts.');
  const pass = requireString('GMAIL_APP_PASSWORD', 'Required to send operational alerts.');
  transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    // Google displays app passwords in groups of four and people paste them as shown.
    auth: { user, pass: pass.replace(/\s/g, '') },
  });
  return transport;
}

async function deliver(alert: Alert, suppressed: number): Promise<string | null> {
  const to = optionalString('NOTIFY_EMAIL') ?? optionalString('GMAIL_USER');
  if (to === undefined) return 'NOTIFY_EMAIL and GMAIL_USER are both unset';

  const tag = alert.severity.toUpperCase();
  const preamble =
    suppressed > 0
      ? `This condition also occurred ${suppressed} time(s) since the last alert, which were suppressed by the cooldown.\n\n`
      : '';

  try {
    await gmailTransport().sendMail({
      from: requireString('GMAIL_USER', 'alert sender'),
      to,
      subject: `[job-scraper ${tag}] ${alert.subject}`,
      text: `${preamble}${alert.body}\n\n--\nalert key: ${alert.key}\n`,
    });
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Raises an alert, sending it unless an identical key went out inside the
 * cooldown. Never throws — a failure here must not take down the stage that was
 * trying to report a problem.
 */
export async function raiseAlert(alert: Alert): Promise<void> {
  try {
    const settings = await alertSettings();
    if (!settings.enabled) {
      console.log(`  alert suppressed (alerts_enabled is false): ${alert.subject}`);
      return;
    }

    const previous = await lastSend(alert.key);
    const cooledOff =
      previous === null ||
      Date.now() - previous.sentAt.getTime() >= settings.cooldownMinutes * 60_000;

    if (!cooledOff) {
      // Record the occurrence without sending, so the next email can say how many
      // it stood in for and the dashboard can show the true frequency.
      await db().from('alert_log').insert({
        alert_key: alert.key,
        severity: alert.severity,
        subject: alert.subject,
        body: alert.body,
        delivered: false,
      });
      console.log(`  alert throttled (${settings.cooldownMinutes}m cooldown): ${alert.subject}`);
      return;
    }

    const suppressed = previous === null ? 0 : await countSuppressedSince(alert.key, previous.sentAt);
    const failure = await deliver(alert, suppressed);

    await db().from('alert_log').insert({
      alert_key: alert.key,
      severity: alert.severity,
      subject: alert.subject,
      body: alert.body,
      suppressed_since_last: suppressed,
      delivered: failure === null,
      delivery_error: failure,
    });

    if (failure === null) console.log(`  alert sent: ${alert.subject}`);
    else console.error(`  alert delivery failed: ${failure}`);
  } catch (err: unknown) {
    // Deliberately swallowed. See the file header.
    console.error(`  alerting failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Run log ----------------------------------------------------------------

export type Stage = 'ingest' | 'process' | 'outreach' | 'followup';

export async function startRun(stage: Stage): Promise<string | null> {
  const { data, error } = await db().from('run_log').insert({ stage }).select('id').single();
  if (error) {
    console.error(`  could not open run_log row: ${error.message}`);
    return null;
  }
  return (data as { id: string }).id;
}

export async function finishRun(
  id: string | null,
  ok: boolean,
  stats: Record<string, unknown>,
  error?: string,
): Promise<void> {
  if (id === null) return;
  const { error: dbError } = await db()
    .from('run_log')
    .update({
      finished_at: new Date().toISOString(),
      ok,
      stats,
      error: error ?? null,
    })
    .eq('id', id);
  if (dbError) console.error(`  could not close run_log row: ${dbError.message}`);
}

/**
 * Alerts used across stages. Keys are stable strings so the cooldown groups
 * repeats of the same condition rather than treating each run as novel.
 */
export const alerts = {
  stageFailed: (stage: Stage, message: string): Alert => ({
    key: `stage_failed:${stage}`,
    severity: 'error',
    subject: `${stage} stage failed`,
    body: `The ${stage} stage threw and did not complete.\n\n${message}`,
  }),

  capHit: (sent: number, cap: number): Alert => ({
    key: 'daily_cap_hit',
    severity: 'info',
    subject: `daily send cap reached (${sent}/${cap})`,
    body: `The daily send cap has been reached. Remaining queued items will wait for tomorrow.`,
  }),

  replyReceived: (company: string, title: string, url: string): Alert => ({
    // Deliberately per-opportunity: every reply is news, and none should be
    // throttled away behind another.
    key: `reply:${company}:${title}`.slice(0, 200),
    severity: 'info',
    subject: `reply received — ${company}`,
    body: `A reply came in for ${title} at ${company}.\n\n${url}`,
  }),

  boardsFailing: (vendor: string, failures: string[]): Alert => ({
    key: `boards_failing:${vendor}`,
    severity: 'warn',
    subject: `${failures.length} ${vendor} board(s) failing`,
    body: `These boards returned errors on the last run:\n\n${failures.map((f) => `  - ${f}`).join('\n')}`,
  }),

  nothingIngested: (hours: number): Alert => ({
    key: 'ingest_stale',
    severity: 'error',
    subject: `no successful ingest in ${hours} hours`,
    body: `The ingest stage has not completed successfully in ${hours} hours. Either the cron is not firing or every source is failing.`,
  }),
};
