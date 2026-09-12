/**
 * scripts/detect-watchlist.ts
 *
 * Resolves the candidate company list to {vendor, token} pairs by probing each
 * vendor's public endpoint, and prints them for review.
 *
 *   npm run detect:watchlist              # probe and report, write nothing
 *   npm run detect:watchlist -- --write   # also insert the ingestable hits
 *
 * Writes nothing by default, and inserts as active = false even with --write.
 * Detection is a heuristic: a confident match on a similarly-named company would
 * put applications in front of an employer you never chose, so a human approves
 * the list before anything is polled.
 */

import { readFile } from 'node:fs/promises';
import { db } from '../worker/lib/db.js';
import { detectMany, INGESTABLE, type Detected } from '../worker/sources/detect.js';

const LIST_PATH = 'knowledge/watchlist-candidates.txt';

type Candidate = { company: string; careersUrl?: string };

async function readCandidates(path: string): Promise<Candidate[]> {
  const text = await readFile(path, 'utf8');
  const out: Candidate[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const [name, url] = line.split('|').map((s) => s.trim());
    if (name === undefined || name.length === 0) continue;
    out.push(url === undefined || url.length === 0 ? { company: name } : { company: name, careersUrl: url });
  }
  return out;
}

async function insert(found: Detected[]): Promise<void> {
  const usable = found.filter((f) => INGESTABLE.includes(f.vendor));
  if (usable.length === 0) {
    console.log('\nnothing ingestable to write');
    return;
  }
  const rows = usable.map((f) => ({
    company: f.company,
    ats_vendor: f.vendor,
    board_token: f.token,
    active: false,
    notes: `detected ${new Date().toISOString().slice(0, 10)}; ${f.jobCount} jobs at detection`,
  }));

  const { data, error } = await db()
    .from('company_watchlist')
    .upsert(rows, { onConflict: 'ats_vendor,board_token', ignoreDuplicates: true })
    .select('company');
  if (error) throw new Error(`insert failed: ${error.message}`);

  console.log(`\ninserted ${data?.length ?? 0} new rows, all active = false`);
  console.log('Review them, then activate the ones you want:');
  console.log("  update company_watchlist set active = true where board_token in ('...');");
}

async function main(): Promise<void> {
  const candidates = await readCandidates(LIST_PATH);
  console.log(`probing ${candidates.length} companies from ${LIST_PATH}\n`);

  const { found, unresolved } = await detectMany(candidates);

  const byVendor: Record<string, Detected[]> = {};
  for (const f of found) (byVendor[f.vendor] ??= []).push(f);

  console.log(`\n=== resolved ${found.length}/${candidates.length} ===`);
  for (const [vendor, hits] of Object.entries(byVendor).sort((a, b) => b[1].length - a[1].length)) {
    const usable = INGESTABLE.includes(vendor as never);
    const jobs = hits.reduce((a, h) => a + h.jobCount, 0);
    console.log(`\n${vendor}  ${hits.length} companies, ${jobs} jobs${usable ? '' : '  <-- NO ADAPTER, will not ingest'}`);
    for (const h of hits.sort((a, b) => b.jobCount - a.jobCount)) {
      console.log(`  ${String(h.jobCount).padStart(4)}  ${h.company.padEnd(18)} ${h.token}`);
    }
  }

  if (unresolved.length > 0) {
    console.log(`\n=== unresolved (${unresolved.length}) ===`);
    console.log('  ' + unresolved.join(', '));
    console.log('\n  A miss means no public board was found at any guessed slug. Either the');
    console.log('  company uses an ATS with no public feed, self-hosts, or the slug differs');
    console.log('  from the name. Add "Name | https://their-careers-url" to resolve directly.');
  }

  if (process.argv.includes('--write')) await insert(found);
  else console.log('\nNothing written. Re-run with --write to insert as inactive rows.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
