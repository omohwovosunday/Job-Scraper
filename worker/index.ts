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

import { readSettings } from './lib/settings.js';

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
    case 'ingest':
      notBuiltYet(stage, 'build order step 3 (RemoteOK) and step 4 (Greenhouse board)');
    case 'process':
      notBuiltYet(stage, 'build order steps 5 to 7 (resolve, score, draft)');
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
