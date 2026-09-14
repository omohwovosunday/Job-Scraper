/**
 * scripts/draft-smoke.ts
 *
 * Drafts a few listings and prints the letters in full.
 *
 *   npm run draft:smoke        # 1 listing
 *   npm run draft:smoke -- 5   # 5 listings
 *
 * The point is reading the output, not the counters. The step 7 review gate asks
 * three questions of every draft — does it sound like you, is anything untrue,
 * would you send it — and none of them can be answered from a summary line.
 *
 * It writes real drafts to real rows. Nothing is sent: no sender exists.
 */

import { runDraft } from '../worker/llm/drafter.js';
import { selectAllRowsWhere } from '../worker/lib/db.js';
import { readSettings } from '../worker/lib/settings.js';

type Drafted = {
  company: string | null;
  title: string;
  score: number | null;
  apply_method: string | null;
  tier: string | null;
  draft_subject: string | null;
  draft_body: string | null;
  case_study_used: string | null;
  error: string | null;
};

function parseLimit(argv: string[]): number {
  const raw = argv[2];
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Limit must be a positive integer, got "${raw}".`);
  return n;
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv);

  const settings = await readSettings();
  if (settings.killSwitch) {
    console.log('kill_switch is on. Doing nothing.');
    return;
  }

  console.log(`Drafting at most ${limit} listing(s).\n`);
  const stats = await runDraft(limit);

  console.log(
    `\ndraft considered=${stats.considered} drafted=${stats.drafted} auto=${stats.auto} ` +
      `auto_flagged=${stats.autoFlagged} manual=${stats.manual} failed=${stats.failed} ` +
      `apiCalls=${stats.apiCalls} cache_created=${stats.cacheCreated} cache_read=${stats.cacheRead}`,
  );

  const rows = await selectAllRowsWhere<Drafted>(
    'opportunities',
    'company, title, score, apply_method, tier, draft_subject, draft_body, case_study_used, error',
    'status',
    'drafted',
  );

  console.log('\n--- every draft written, read all of them ---');
  for (const r of rows) {
    if (r.draft_body === null) continue;
    console.log(`\n${'='.repeat(72)}`);
    console.log(`[${r.score}] ${r.company} — ${r.title}`);
    console.log(`tier=${r.tier}  apply=${r.apply_method}  leads with ${r.case_study_used ?? '(none)'}`);
    if (r.error !== null) console.log(`downgraded: ${r.error}`);
    if (r.draft_subject !== null) console.log(`\nSubject: ${r.draft_subject}`);
    console.log(`\n${r.draft_body}`);
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log('Check three things in each: does it sound like you, is anything untrue,');
  console.log('would you send it as written. The ones you reject here are the cheapest');
  console.log('feedback you will get — after this it is silence from hiring managers.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
