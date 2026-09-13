/**
 * worker/index.ts
 *
 * Stage entrypoints: ingest | process | outreach | followup.
 *
 * GitHub Actions cron fires late under load, and a run can be killed mid-flight.
 * Every stage must therefore be idempotent and resumable: pick up whatever is in
 * the right status, never assume the previous run finished.
 *
 * Every run opens a row in run_log and closes it. That matters for the failure a
 * try/catch cannot see: a stage that never starts throws nothing anywhere, so the
 * dashboard watches the age of the newest row rather than the outcome of the last.
 */

import { finishRun, raiseAlert, startRun, alerts, type Stage } from './lib/alerts.js';
import { runIngest } from './lib/ingest.js';
import { readSettings } from './lib/settings.js';
import { assertCommercialEnv } from './llm/config.js';
import { runDraft } from './llm/drafter.js';
import { runScore } from './llm/scorer.js';
import { runResolve } from './resolve/index.js';
import { runSend } from './submit/index.js';
import { SOURCES } from './sources/index.js';

const STAGES = ['ingest', 'process', 'outreach', 'followup'] as const;

function parseStage(argv: string[]): Stage {
  const arg = argv[2];
  if (arg !== undefined && (STAGES as readonly string[]).includes(arg)) return arg as Stage;
  throw new Error(
    `Usage: tsx worker/index.ts <${STAGES.join(' | ')}>\n` +
      `Received: ${arg === undefined ? '(nothing)' : JSON.stringify(arg)}`,
  );
}

async function ingestStage(): Promise<Record<string, unknown>> {
  const result = await runIngest(SOURCES);
  console.log(`ingest total new=${result.totalInserted}`);

  const failed = result.perSource.filter((s) => s.error !== undefined);
  if (failed.length === result.perSource.length && failed.length > 0) {
    throw new Error('every source failed');
  }
  // A single failing source is not a run failure, but it is worth knowing about
  // before it has been silently returning nothing for a week.
  if (failed.length > 0) {
    await raiseAlert(
      alerts.boardsFailing('source', failed.map((f) => `${f.source}: ${f.error ?? 'unknown'}`)),
    );
  }

  const resolved = await runResolve();
  const { byMethod } = resolved;
  console.log(
    `resolve considered=${resolved.considered} fetched=${resolved.fetched} ` +
      `ats=${byMethod.ats} email=${byMethod.email} form=${byMethod.form} ` +
      `unresolved=${byMethod.unresolved}`,
  );
  if (resolved.discoveredBoards > 0) {
    console.log(
      `resolve discovered ${resolved.discoveredBoards} new ATS board(s), stored inactive ` +
        '— review company_watchlist and set active = true to poll them',
    );
  }

  return {
    inserted: result.totalInserted,
    sourcesFailed: failed.length,
    resolved: resolved.considered,
    byMethod,
  };
}

async function processStage(): Promise<Record<string, unknown>> {
  assertCommercialEnv();
  const scored = await runScore();
  console.log(
    `score considered=${scored.considered} prefiltered=${scored.prefiltered} ` +
      `scored=${scored.scored} passed=${scored.passed} skipped=${scored.skipped} ` +
      `failed=${scored.failed} apiCalls=${scored.apiCalls}`,
  );
  const reasons = Object.entries(scored.prefilterReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([flag, n]) => `${flag}=${n}`)
    .join(' ');
  if (reasons !== '') console.log(`prefilter ${reasons}`);

  const drafted = await runDraft();
  console.log(
    `draft considered=${drafted.considered} drafted=${drafted.drafted} ` +
      `auto=${drafted.auto} auto_flagged=${drafted.autoFlagged} manual=${drafted.manual} ` +
      `failed=${drafted.failed} apiCalls=${drafted.apiCalls}`,
  );
  const downgrades = Object.entries(drafted.downgradeReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason}=${n}`)
    .join(' ');
  if (downgrades !== '') console.log(`downgrades ${downgrades}`);

  const sent = await runSend();
  console.log(
    `send eligible=${sent.eligible} sent=${sent.sent} skipped=${sent.skipped} ` +
      `failed=${sent.failed} dry_run=${sent.dryRun} cap_remaining=${sent.capRemaining}`,
  );

  // Namespaced, not spread together: the stats objects share considered, failed
  // and apiCalls, so a flat merge would silently record the drafter's numbers as
  // the scorer's in run_log and the dashboard would report the wrong API spend.
  return { score: { ...scored }, draft: { ...drafted }, send: { ...sent } };
}

async function main(): Promise<void> {
  const stage = parseStage(process.argv);
  const startedAt = Date.now();

  const settings = await readSettings();
  if (settings.killSwitch) {
    console.log(`kill_switch is on. Stage "${stage}" is doing nothing.`);
    return;
  }

  console.log(
    `stage=${stage} dry_run=${settings.dryRun} daily_send_cap=${settings.dailySendCap}`,
  );

  const runId = await startRun(stage);
  try {
    let stats: Record<string, unknown> = {};
    switch (stage) {
      case 'ingest':
        stats = await ingestStage();
        break;
      case 'process':
        stats = await processStage();
        break;
      case 'outreach':
      case 'followup':
        console.log(`Stage "${stage}" is build order step 10 and is not built yet.`);
        break;
    }

    const seconds = (Date.now() - startedAt) / 1000;
    await finishRun(runId, true, { ...stats, seconds });
    console.log(`done in ${seconds.toFixed(1)}s`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(runId, false, { seconds: (Date.now() - startedAt) / 1000 }, message);
    await raiseAlert(alerts.stageFailed(stage, message));
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
