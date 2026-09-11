/**
 * scripts/seed-knowledge.ts
 *
 * Pushes the local /knowledge files into the Supabase `knowledge` table, which is
 * the canonical copy. Run after editing a file locally; after this, routine edits
 * can be made in the database directly and no deploy is needed.
 *
 *   npm run seed:knowledge
 *
 * Refuses to upload a case study still carrying FILL markers. Two studies were
 * dropped in September 2026 for exactly that reason — the drafter is forbidden from
 * inventing facts, so it must never be handed a study it cannot quote from.
 */

import { readFile } from 'node:fs/promises';
import { db } from '../worker/lib/db.js';
import { CASE_STUDIES } from '../worker/llm/config.js';
import { caseStudyKey, type KnowledgeKey } from '../worker/lib/knowledge.js';

const KNOWLEDGE_DIR = 'knowledge';

type Entry = { key: KnowledgeKey; path: string };

const entries: Entry[] = [
  { key: 'profile', path: `${KNOWLEDGE_DIR}/profile.md` },
  { key: 'voice-sample', path: `${KNOWLEDGE_DIR}/voice-sample.md` },
  ...CASE_STUDIES.map((slug) => ({
    key: caseStudyKey(slug),
    path: `${KNOWLEDGE_DIR}/case-studies/${slug}.md`,
  })),
];

/** An unfilled placeholder in the knowledge base becomes an invented fact downstream. */
function findPlaceholders(content: string): string[] {
  const found: string[] = [];
  if (/<!--\s*FILL/i.test(content)) found.push('FILL comment');
  if (/\b__\b/.test(content)) found.push('unfilled __ field');
  if (/\bTODO\b/.test(content)) found.push('TODO');
  return found;
}

async function main(): Promise<void> {
  const rows: { key: string; content: string }[] = [];
  const problems: string[] = [];

  for (const { key, path } of entries) {
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      problems.push(`${path} — not found`);
      continue;
    }

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      problems.push(`${path} — empty`);
      continue;
    }

    const placeholders = findPlaceholders(content);
    if (placeholders.length > 0) {
      problems.push(`${path} — contains ${placeholders.join(', ')}`);
      continue;
    }

    rows.push({ key, content: trimmed });
  }

  if (problems.length > 0) {
    console.error('Refusing to seed. Fix these first:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nNothing was written. A placeholder here becomes a fabricated claim in an\n' +
        'application, which is the one failure that costs you in an interview.',
    );
    process.exit(1);
  }

  const { error } = await db().from('knowledge').upsert(rows, { onConflict: 'key' });
  if (error) throw new Error(`Seed failed: ${error.message}`);

  console.log(`Seeded ${rows.length} knowledge rows:`);
  for (const row of rows) {
    console.log(`  ${row.key.padEnd(28)} ${row.content.length.toLocaleString()} chars`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
