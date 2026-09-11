/**
 * worker/lib/knowledge.ts
 *
 * Knowledge base access. Rows live in Supabase (instructions 2.2) because the repo
 * is public and /knowledge is gitignored. Fetched once per run and cached in memory
 * for the run's duration, so a stage that scores 200 listings makes one query.
 */

import { db } from './db.js';
import { CASE_STUDIES, type CaseStudy } from '../llm/config.js';

export type KnowledgeKey = 'profile' | 'voice-sample' | `case-study:${CaseStudy}`;

export function caseStudyKey(slug: CaseStudy): KnowledgeKey {
  return `case-study:${slug}`;
}

let cache: Map<string, string> | undefined;

/** Loads every knowledge row once per process. Subsequent calls hit the cache. */
export async function loadKnowledge(): Promise<Map<string, string>> {
  if (cache) return cache;

  const { data, error } = await db().from('knowledge').select('key, content');
  if (error) throw new Error(`Failed to load knowledge base: ${error.message}`);

  const loaded = new Map<string, string>();
  for (const row of data ?? []) loaded.set(row.key as string, row.content as string);

  const required: KnowledgeKey[] = [
    'profile',
    'voice-sample',
    ...CASE_STUDIES.map(caseStudyKey),
  ];
  const missing = required.filter((key) => !loaded.has(key));
  if (missing.length > 0) {
    throw new Error(
      `Knowledge base incomplete. Missing: ${missing.join(', ')}. ` +
        'Run `npm run seed:knowledge` with the files present in /knowledge.',
    );
  }

  cache = loaded;
  return cache;
}

export async function getKnowledge(key: KnowledgeKey): Promise<string> {
  const all = await loadKnowledge();
  const content = all.get(key);
  if (content === undefined) throw new Error(`Knowledge key not found: ${key}`);
  return content;
}

/** Test seam — drops the in-memory cache. */
export function resetKnowledgeCache(): void {
  cache = undefined;
}
