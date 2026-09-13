/**
 * scripts/score-smoke.ts
 *
 * Scores a small slice of the queue instead of all of it.
 *
 *   npm run score:smoke        # 10 rows, one API call
 *   npm run score:smoke -- 30  # 30 rows, three calls
 *
 * This exists because of a hard quota, not a soft preference. gemini-3.5-flash on
 * the free tier allows roughly 20 requests per DAY, and `npm run process` scores
 * every resolved row — currently 95 survivors at 10 per call, so ten calls in one
 * go. Half the day's budget, with nothing held back for a retry if the prompt turns
 * out to need a change.
 *
 * A batch that overruns its token budget is split and retried, so the call count is
 * a floor rather than an exact figure. Expect a few more than rows/10.
 *
 * It writes real scores to real rows. It is a smaller run, not a dry one.
 */

import { runScore } from '../worker/llm/scorer.js';
import { assertCommercialEnv } from '../worker/llm/config.js';
import { readSettings } from '../worker/lib/settings.js';

const DEFAULT_LIMIT = 10;

function parseLimit(argv: string[]): number {
  const raw = argv[2];
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Limit must be a positive integer, got "${raw}".`);
  }
  return n;
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv);
  assertCommercialEnv();

  // The kill switch is honoured here as it is in the stage runner. A smoke test
  // that ignored it would be the one path that keeps calling a paid API after
  // someone hit stop.
  const settings = await readSettings();
  if (settings.killSwitch) {
    console.log('kill_switch is on. Doing nothing.');
    return;
  }

  console.log(`Scoring at most ${limit} rows (roughly ${Math.ceil(limit / 10)} API calls).\n`);
  const stats = await runScore(limit);

  console.log(
    `\nscore considered=${stats.considered} prefiltered=${stats.prefiltered} ` +
      `scored=${stats.scored} passed=${stats.passed} skipped=${stats.skipped} ` +
      `failed=${stats.failed} apiCalls=${stats.apiCalls}`,
  );
  const reasons = Object.entries(stats.prefilterReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([flag, n]) => `${flag}=${n}`)
    .join(' ');
  if (reasons !== '') console.log(`prefilter ${reasons}`);
  console.log('\nRead the scores before scoring the rest: npm run score:report');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
