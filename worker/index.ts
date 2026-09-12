/**
 * worker/index.ts
 *
 * Stage entrypoints: ingest | process | outreach | followup.
 *
 * GitHub Actions cron fires late under load, and a run can be killed mid-flight.
 * Every stage must therefore be idempotent and resumable: pick up whatever is in
 * the right status, never assume the previous run finished.
 *
 * Stages are implemented in build order. An unbuilt stage exits with a message
 * naming the step rather than failing obscurely.
 */

import { runIngest } from './lib/ingest.js';
import { runResolve } from './resolve/index.js';
import { readSettings } from './lib/settings.js';
import { assertCommercialEnv } from './llm/config.js';
import { runScore } from './llm/scorer.js';
import { SOURCES } from './sources/index.js';

const STAGES = ['ingest', 'process', 'outreach', 'followup'] as const;
type Stage = (typeof STAGES)[number];

function parseStage(argv: string[]): Stage {
  const arg = argv[2];
  if (arg !== undefined && (STAGES as readonly string[]).includes(arg)) {
    return arg as Stage;
  }
  throw new Error(
    `Usage: tsx worker/index.ts <${STAGES.join(' | ')}>\n` +
      `Received: ${arg === undefined ? '(nothing)' : JSON.stringify(arg)}`,
  );
}

function notBuiltYet(stage: Stage, step: string): never {
  console.log(`Stage "${stage}" is not built yet — ${step}.`);
  process.exit(0);
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

  switch (stage) {
    case 'ingest': {
      const result = await runIngest(SOURCES);
      console.log(`ingest total new=${result.totalInserted}`);
      const failed = result.perSource.filter((s) => s.error !== undefined);
      // A failing board is reported but does not fail the run; the next cron
      // retries it, and the other sources already did their work.
      if (failed.length === result.perSource.length && failed.length > 0) {
        throw new Error('every source failed');
      }

      // Spec 2 puts apply-path resolution in this stage, after dedupe.
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
      break;
    }
    case 'process': {
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
      notBuiltYet(stage, 'the drafter is build order step 7');
    }
    case 'outreach':
      notBuiltYet(stage, 'build order step 10');
    case 'followup':
      notBuiltYet(stage, 'build order step 10');
  }

  console.log(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
