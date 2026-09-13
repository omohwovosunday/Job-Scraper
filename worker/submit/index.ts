/**
 * worker/submit/index.ts
 *
 * The send stage. This is the one place in the codebase that acts on the outside
 * world in a way that cannot be undone.
 *
 * Five gates stand in front of every send, and all five fail closed:
 *
 *   1. kill_switch      — checked by the stage runner before this is reached
 *   2. dry_run          — renders the message and writes nothing. Default true.
 *   3. tier === 'auto'  — auto_flagged and manual are never sent by machine
 *   4. apply_method === 'email' with a plausible target
 *   5. daily_send_cap   — counted from sent_log, not from an in-memory tally
 *
 * The ordering matters. dry_run is checked before anything is selected, so a run
 * with the flag on cannot send even if every other gate is misconfigured.
 *
 * A send is not idempotent and not reversible. Everything else in this pipeline can
 * be re-run; an email cannot be recalled. So the failure mode chosen everywhere
 * here is "send nothing and say why", never "send and hope".
 */

import { db, selectAllRows, selectAllRowsWhere } from '../lib/db.js';
import { alerts, raiseAlert } from '../lib/alerts.js';
import { normaliseCompany } from '../lib/dedupe.js';
import { readSettings } from '../lib/settings.js';
import { buildMessage, sendApplication, UnsendableError } from './email.js';

/**
 * Don't apply to the same company twice inside this window.
 *
 * dedupe_hash includes the posting date, so one company reposting a role, or
 * running two openings with the same title, produces two rows that are genuinely
 * distinct records and identical applications. Resend had exactly this on
 * 2026-09-14: two Ashby listings, both "Product Designer", posted five weeks apart,
 * whose drafts both opened with the same PayAfta paragraph.
 *
 * dedupe.ts has always said the fix belongs at the send gate rather than in the
 * hash, because the hash is right to treat them as different listings and the
 * recipient is what makes it wrong to mail both.
 */
const COMPANY_COOLDOWN_DAYS = 30;

type Sendable = {
  id: string;
  company: string | null;
  title: string;
  tier: string | null;
  apply_method: string | null;
  apply_target: string | null;
  draft_subject: string | null;
  draft_body: string | null;
  resume_variant: string | null;
  case_study_used: string | null;
};

export type SenderStats = {
  eligible: number;
  sent: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  capRemaining: number;
};

/**
 * How many went out today, counted from sent_log rather than tracked in memory.
 *
 * The cap has to survive a crashed run and two runs overlapping. A counter held in
 * the process would reset on restart and let a retry double the day's sends, which
 * is the one accounting error that reaches employers.
 */
export async function sentToday(): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count, error } = await db()
    .from('sent_log')
    .select('id', { count: 'exact', head: true })
    .eq('channel', 'email')
    .gte('sent_at', since.toISOString());
  if (error) throw new Error(`Could not count today's sends: ${error.message}`);
  return count ?? 0;
}

/**
 * Companies already applied to inside the cooldown, normalised for comparison.
 *
 * Read from opportunities rather than sent_log because sent_log stores the address
 * and not the employer, and two Recruitee mailboxes at one company differ per job.
 */
export async function recentlyAppliedCompanies(days = COMPANY_COOLDOWN_DAYS): Promise<Set<string>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await selectAllRows<{ company: string | null; sent_at: string | null }>(
    'opportunities',
    'company, sent_at',
  );
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.sent_at === null) continue;
    if (new Date(row.sent_at) < since) continue;
    const key = normaliseCompany(row.company);
    if (key !== '') seen.add(key);
  }
  return seen;
}

export async function runSend(): Promise<SenderStats> {
  const settings = await readSettings();

  const rows = await selectAllRowsWhere<Sendable>(
    'opportunities',
    'id, company, title, tier, apply_method, apply_target, draft_subject, draft_body, ' +
      'resume_variant, case_study_used',
    'status',
    'drafted',
  );

  // Gate 3 and 4. Everything else queued stays queued: a human sends it, or it
  // waits for a review that promotes it.
  const eligible = rows.filter((r) => r.tier === 'auto' && r.apply_method === 'email');

  const already = await sentToday();
  const capRemaining = Math.max(0, settings.dailySendCap - already);

  const stats: SenderStats = {
    eligible: eligible.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    dryRun: settings.dryRun,
    capRemaining,
  };

  if (eligible.length === 0) {
    console.log('  nothing is tier=auto with an email apply path. Nothing to send.');
    return stats;
  }

  // Gate 2, before any message is built. A dry run must be incapable of sending,
  // not merely instructed not to.
  if (settings.dryRun) {
    console.log(`  DRY RUN — ${eligible.length} would be sent. Nothing leaves this machine.`);
    for (const row of eligible) {
      console.log(`\n  would send to ${row.apply_target}`);
      console.log(`  subject: ${row.draft_subject}`);
      console.log(`  resume:  ${row.resume_variant ?? '(default)'}`);
      console.log(`  ${String(row.draft_body ?? '').split('\n')[0]?.slice(0, 90)}...`);
      stats.skipped += 1;
    }
    return stats;
  }

  if (capRemaining === 0) {
    console.log(`  daily send cap reached (${already}/${settings.dailySendCap}). Nothing sent.`);
    await raiseAlert(alerts.capHit(already, settings.dailySendCap));
    stats.skipped = eligible.length;
    return stats;
  }

  // Gate 6. Built from the database before the loop, then added to as sends happen,
  // so two rows for the same company inside one run cannot both go out.
  const applied = await recentlyAppliedCompanies();

  for (const row of eligible) {
    if (stats.sent >= capRemaining) {
      stats.skipped += 1;
      continue;
    }

    const companyKey = normaliseCompany(row.company);
    if (companyKey !== '' && applied.has(companyKey)) {
      await db().from('opportunities')
        .update({
          tier: 'manual',
          error: `already applied to ${row.company} in the last ${COMPANY_COOLDOWN_DAYS} days`,
        })
        .eq('id', row.id);
      stats.skipped += 1;
      console.log(`  HELD ${row.company} — already applied inside the cooldown`);
      continue;
    }

    let message;
    try {
      message = await buildMessage(row);
    } catch (err: unknown) {
      // A message that cannot be built is a data problem, not a transport one.
      // Route it to a human rather than retrying it on every run forever.
      const why = err instanceof Error ? err.message : String(err);
      await db().from('opportunities')
        .update({ tier: 'manual', error: `not sendable: ${why}` })
        .eq('id', row.id);
      stats.failed += 1;
      console.error(`  UNSENDABLE ${row.company}: ${why}`);
      if (!(err instanceof UnsendableError)) throw err; // a missing resume is systemic
      continue;
    }

    try {
      const messageId = await sendApplication(message);

      // sent_log is written before the status change. If the process dies between
      // the two, the cap still counts this send and the row is re-examined; the
      // reverse order would lose the record of a mail that actually went out.
      await db().from('sent_log').insert({
        opportunity_id: row.id,
        channel: 'email',
        sender: process.env.GMAIL_USER ?? null,
        to_address: message.to,
        subject: message.subject,
        body: message.text,
        provider_message_id: messageId,
      });
      await db().from('opportunities')
        .update({ status: 'sent', sent_at: new Date().toISOString(), error: null })
        .eq('id', row.id);

      stats.sent += 1;
      if (companyKey !== '') applied.add(companyKey);
      console.log(`  SENT ${row.company} — ${row.title} -> ${message.to}`);
    } catch (err: unknown) {
      const why = err instanceof Error ? err.message : String(err);
      await db().from('opportunities').update({ error: `send failed: ${why}` }).eq('id', row.id);
      stats.failed += 1;
      console.error(`  SEND FAILED ${row.company}: ${why}`);
    }
  }

  if (stats.sent > 0 && stats.sent >= capRemaining) {
    await raiseAlert(alerts.capHit(already + stats.sent, settings.dailySendCap));
  }
  return stats;
}
