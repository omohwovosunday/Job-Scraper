/**
 * scripts/verify-dedupe.ts
 *
 * Build order step 3: "Run three times; verify dedup produces no duplicates."
 *
 * Runs ingest three times against the live feed and asserts:
 *   1. Runs 2 and 3 insert nothing. The feed barely changes in a few seconds, so
 *      anything inserted on a later pass means the hash is unstable.
 *   2. No dedupe_hash appears twice in the table.
 *   3. The row count after run 3 equals the count after run 1, plus any genuinely
 *      new postings the feed published mid-test.
 *
 * Read-only on the feed, insert-only on the database. Safe to re-run.
 *
 *   npx tsx scripts/verify-dedupe.ts
 */

import { db } from '../worker/lib/db.js';
import { runIngest } from '../worker/lib/ingest.js';
import { SOURCES } from '../worker/sources/index.js';

async function rowCount(): Promise<number> {
  const { count, error } = await db()
    .from('opportunities')
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(`count failed: ${error.message}`);
  return count ?? 0;
}

/** The unique constraint should make this impossible. Check anyway. */
async function findDuplicateHashes(): Promise<string[]> {
  const { data, error } = await db().from('opportunities').select('dedupe_hash');
  if (error) throw new Error(`duplicate scan failed: ${error.message}`);

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of data ?? []) {
    const hash = row.dedupe_hash as string;
    if (seen.has(hash)) duplicates.add(hash);
    seen.add(hash);
  }
  return [...duplicates];
}

async function main(): Promise<void> {
  const before = await rowCount();
  console.log(`rows before: ${before}\n`);

  const inserted: number[] = [];
  for (let pass = 1; pass <= 3; pass += 1) {
    console.log(`--- pass ${pass} ---`);
    const result = await runIngest(SOURCES);
    inserted.push(result.totalInserted);
    console.log('');
  }

  const after = await rowCount();
  const duplicates = await findDuplicateHashes();

  console.log('--- verification ---');
  console.log(`inserted per pass : ${inserted.join(', ')}`);
  console.log(`rows before/after : ${before} / ${after}`);
  console.log(`duplicate hashes  : ${duplicates.length}`);

  const failures: string[] = [];

  if (inserted[1] !== 0 || inserted[2] !== 0) {
    failures.push(
      `passes 2 and 3 inserted ${inserted[1]} and ${inserted[2]} rows; both must be 0. ` +
        'The hash is not stable across runs — check normaliseCompany and posted_at.',
    );
  }
  if (duplicates.length > 0) {
    failures.push(`${duplicates.length} dedupe_hash values appear more than once.`);
  }
  const expected = before + inserted.reduce((a, b) => a + b, 0);
  if (after !== expected) {
    failures.push(`row count is ${after}, expected ${expected}.`);
  }

  if (failures.length > 0) {
    console.error('\nFAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('\nPASS: dedupe is stable across three runs.');
  if (inserted[0] === 0) {
    console.log(
      'Note: pass 1 also inserted 0. The table already held this feed, so this run ' +
        'confirmed idempotency but not insertion. Both are working if an earlier run ' +
        'inserted rows.',
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
