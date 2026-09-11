/**
 * worker/lib/settings.ts
 *
 * Runtime flags from the `settings` table — the ones the dashboard can flip without
 * a deploy. Read fresh at the top of every stage, never cached: the whole point of
 * the kill switch is that flipping it takes effect on the next run, not the next
 * deploy.
 *
 * score_threshold is NOT here. It is a commercial figure and lives in the
 * environment (instructions 2.3).
 */

import { db } from './db.js';

export type Settings = {
  killSwitch: boolean;
  dryRun: boolean;
  dailySendCap: number;
};

/** Conservative fallbacks, used only if a key is absent from the table. */
const FALLBACKS: Settings = {
  killSwitch: true,  // absent kill switch reads as ON — fail closed
  dryRun: true,      // absent dry_run reads as ON — never send by accident
  dailySendCap: 0,
};

export async function readSettings(): Promise<Settings> {
  const { data, error } = await db().from('settings').select('key, value');
  if (error) throw new Error(`Failed to read settings: ${error.message}`);

  const raw = new Map<string, unknown>();
  for (const row of data ?? []) raw.set(row.key as string, row.value);

  const bool = (key: string, fallback: boolean): boolean => {
    const v = raw.get(key);
    return typeof v === 'boolean' ? v : fallback;
  };
  const num = (key: string, fallback: number): number => {
    const v = raw.get(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };

  return {
    killSwitch: bool('kill_switch', FALLBACKS.killSwitch),
    dryRun: bool('dry_run', FALLBACKS.dryRun),
    dailySendCap: num('daily_send_cap', FALLBACKS.dailySendCap),
  };
}
