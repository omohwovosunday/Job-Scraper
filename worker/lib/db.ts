/**
 * worker/lib/db.ts
 *
 * Supabase client for the worker. Uses the service role key, which bypasses RLS.
 * Every table has RLS enabled with no permissive policies, so this key is the only
 * way in — it must never reach a browser bundle or a committed file.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireString } from './env.js';

/**
 * PostgREST caps a select at 1,000 rows by default and gives no indication that it
 * truncated — you get 1,000 rows and no error. Any scan over the whole table has to
 * page, or it silently reports on a prefix. This bit the dedupe verification, which
 * appeared to check every hash and was in fact checking the first thousand.
 */
export const PAGE_SIZE = 1000;

export async function selectAllRows<T>(table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db()
      .from(table)
      .select(columns)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`select from ${table} failed: ${error.message}`);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < PAGE_SIZE) return out;
  }
}

let client: SupabaseClient | undefined;

export function db(): SupabaseClient {
  if (client) return client;

  const url = requireString('SUPABASE_URL', 'The worker cannot run without a database.');
  const key = requireString(
    'SUPABASE_SERVICE_ROLE_KEY',
    'Service role required: RLS is forced on every table and there are no anon policies.',
  );

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
