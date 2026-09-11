/**
 * worker/lib/db.ts
 *
 * Supabase client for the worker. Uses the service role key, which bypasses RLS.
 * Every table has RLS enabled with no permissive policies, so this key is the only
 * way in — it must never reach a browser bundle or a committed file.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireString } from './env.js';

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
