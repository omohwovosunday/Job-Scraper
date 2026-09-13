/**
 * app/src/lib/db.ts
 *
 * Server-only Supabase access for the dashboard.
 *
 * Row-level security is enabled on every table with no permissive policies, so the
 * anon key grants nothing at all. That is deliberate: this repo is public, and a
 * Supabase URL plus anon key in a client bundle would make every draft and every
 * sent application world-readable.
 *
 * The consequence is that the dashboard reads with the SERVICE ROLE, which bypasses
 * RLS, and therefore every query must run on the server. The `server-only` import
 * turns "someone imported this from a client component" into a build error rather
 * than a silent key leak.
 *
 * The env var is deliberately NOT prefixed NEXT_PUBLIC_. Anything so prefixed is
 * inlined into the browser bundle by Next.js.
 */

import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | undefined;

export function db(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server-side, never NEXT_PUBLIC_).',
    );
  }

  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

/** PostgREST caps a select at 1,000 rows and does not say so. Page, or report on a prefix. */
export async function selectAll<T>(table: string, columns: string, orderBy = 'id'): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db()
      .from(table)
      .select(columns)
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}
