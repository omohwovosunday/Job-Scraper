/**
 * scripts/score-report.ts
 *
 * Prints every scored listing for the step 6 review gate.
 *
 *   npm run score:report
 *
 * The calibration procedure in scorer.prompt.md asks for two things: score a
 * sample yourself, blind, and compare; and check specifically for eligibility
 * misses, since a region-restricted listing that slips through costs an
 * application slot and earns a guaranteed rejection.
 *
 * Two failure modes are called out explicitly below because they are the ones that
 * matter: compression (everything clustered in one band, which means the scorer is
 * not discriminating) and comp leakage (comp-unstated listings trending below
 * comp-stated ones, which the prompt forbids).
 */

import { selectAllRows } from '../worker/lib/db.js';
import { commercial, HARD_ZEROS } from '../worker/llm/config.js';

type Row = {
  title: string;
  company: string | null;
  location: string | null;
  comp_raw: string | null;
  score: number | null;
  score_reason: string | null;
  red_flags: unknown;
  resume_variant: string | null;
  case_study_used: string | null;
  status: string;
  url: string;
};

function flagsOf(row: Row): string[] {
  return Array.isArray(row.red_flags) ? (row.red_flags as string[]) : [];
}

async function main(): Promise<void> {
  const threshold = commercial().scoreThreshold;
  const all = await selectAllRows<Row>(
    'opportunities',
    'title, company, location, comp_raw, score, score_reason, red_flags, resume_variant, case_study_used, status, url',
  );

  // Rows the model actually scored. Pre-filtered rows carry score 0 and a reason
  // saying so; they are counted but not listed, since nothing was judged.
  const modelScored = all.filter(
    (r) => r.score !== null && !(r.score_reason ?? '').startsWith('excluded before scoring'),
  );
  const prefiltered = all.filter((r) => (r.score_reason ?? '').startsWith('excluded before scoring'));

  console.log(`threshold ${threshold}`);
  console.log(`rows total ${all.length}  ·  excluded before scoring ${prefiltered.length}  ·  model-scored ${modelScored.length}`);

  if (modelScored.length === 0) {
    console.log('\nNothing has been scored yet. Run: npm run process');
    return;
  }

  const bands: [string, (s: number) => boolean][] = [
    ['0        ', (s) => s === 0],
    ['1-39     ', (s) => s >= 1 && s < 40],
    ['40-59    ', (s) => s >= 40 && s < 60],
    ['60-74    ', (s) => s >= 60 && s < 75],
    ['75-84    ', (s) => s >= 75 && s < 85],
    ['85-100   ', (s) => s >= 85],
  ];
  console.log('\ndistribution');
  for (const [label, test] of bands) {
    const n = modelScored.filter((r) => test(r.score ?? -1)).length;
    const bar = '#'.repeat(Math.min(40, n));
    console.log(`  ${label} ${String(n).padStart(4)} ${bar}`);
  }

  // Compression check. The prompt says a batch of ten from a general board should
  // contain several zeros and at most two or three above 75.
  const mid = modelScored.filter((r) => (r.score ?? 0) >= 60 && (r.score ?? 0) <= 80).length;
  const share = mid / modelScored.length;
  console.log(`\n${(share * 100).toFixed(0)}% of scores sit in 60-80` +
    (share > 0.6 ? '  <-- COMPRESSED: the scorer is not discriminating' : '  (reasonable spread)'));

  /**
   * Comp leakage check, which the prompt asks to be monitored rather than asserted.
   *
   * Only rows actually scored on the rubric count. The prompt tells the model to
   * return 0 and stop evaluating the moment a hard zero applies, so a zeroed row
   * never reaches the compensation dimension and carries no comp flag either way.
   * Counting those as "comp stated" compares hard zeros against real scores and
   * produces a frightening, meaningless gap — this read 2.1 versus 41.9 before the
   * zeros were excluded.
   */
  const hardZeroFlags = new Set<string>(HARD_ZEROS);
  const onRubric = modelScored.filter(
    (r) => (r.score ?? 0) > 0 && !flagsOf(r).some((f) => hardZeroFlags.has(f)),
  );
  const avg = (rows: Row[]) => rows.length === 0 ? null
    : rows.reduce((a, r) => a + (r.score ?? 0), 0) / rows.length;
  const unstated = onRubric.filter((r) => flagsOf(r).includes('comp_unstated'));
  const stated = onRubric.filter((r) => !flagsOf(r).includes('comp_unstated'));
  const uAvg = avg(unstated);
  const sAvg = avg(stated);
  console.log(`\nscored on the rubric (not hard-zeroed): ${onRubric.length}`);
  if (uAvg !== null && sAvg !== null) {
    console.log(`mean score: comp stated ${sAvg.toFixed(1)} (n=${stated.length})  ·  ` +
      `comp unstated ${uAvg.toFixed(1)} (n=${unstated.length})`);
    if (uAvg < sAvg - 8) {
      console.log('  <-- comp-unstated is trending low; the prompt is leaking a penalty it forbids');
    }
  } else {
    console.log('mean score: not comparable yet — one of the two groups is empty');
  }

  const flagTally: Record<string, number> = {};
  for (const r of modelScored) for (const f of flagsOf(r)) flagTally[f] = (flagTally[f] ?? 0) + 1;
  console.log('\nflags raised by the model');
  for (const [f, n] of Object.entries(flagTally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${f}`);
  }

  console.log('\n--- every scored listing, highest first ---');
  for (const r of [...modelScored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    const pass = (r.score ?? 0) >= threshold ? 'PASS' : '    ';
    console.log(`\n[${String(r.score).padStart(3)}] ${pass} ${r.company ?? '?'} — ${r.title}`);
    console.log(`      location: ${r.location ?? '(empty)'}   comp: ${r.comp_raw ?? 'not stated'}`);
    console.log(`      reason:   ${r.score_reason ?? ''}`);
    const flags = flagsOf(r);
    if (flags.length > 0) console.log(`      flags:    ${flags.join(', ')}`);
    if (r.resume_variant !== null || r.case_study_used !== null) {
      console.log(`      material: ${r.resume_variant ?? '-'} / ${r.case_study_used ?? '-'}`);
    }
    console.log(`      status:   ${r.status}`);
    console.log(`      ${r.url}`);
  }

  console.log('\n--- what to check, per the calibration procedure ---');
  console.log('1. Score 20 of these yourself, blind, then compare.');
  console.log('2. Eligibility misses are the serious failure. Any listing above the');
  console.log('   threshold whose body restricts work to a region excluding Nigeria is');
  console.log('   a miss. More than 1 in 20 means the region language needs sharpening');
  console.log('   with the exact phrasings it missed.');
  console.log('3. Only tune the threshold once the rubric itself behaves.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
