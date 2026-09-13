/**
 * Settings writes. Server-side only, so the service role key never leaves the host.
 *
 * The allowlist is the point: this endpoint can flip operational flags and nothing
 * else. Without it, a bug or a crafted request could write score_threshold or any
 * other key — and the commercial figures deliberately live in the environment,
 * not in this table, precisely so they are not reachable from a web request.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const WRITABLE: Record<string, 'boolean' | 'number'> = {
  kill_switch: 'boolean',
  dry_run: 'boolean',
  alerts_enabled: 'boolean',
  daily_send_cap: 'number',
  alert_cooldown_minutes: 'number',
};

export async function POST(request: Request) {
  let payload: { key?: unknown; value?: unknown };
  try {
    payload = await request.json();
  } catch {
    return new NextResponse('body must be JSON', { status: 400 });
  }

  const key = typeof payload.key === 'string' ? payload.key : null;
  if (key === null || !(key in WRITABLE)) {
    return new NextResponse(`not a writable setting: ${String(payload.key)}`, { status: 400 });
  }

  const expected = WRITABLE[key];
  if (typeof payload.value !== expected) {
    return new NextResponse(`${key} must be a ${expected}`, { status: 400 });
  }
  if (expected === 'number' && !Number.isFinite(payload.value as number)) {
    return new NextResponse(`${key} must be a finite number`, { status: 400 });
  }

  const { error } = await db().from('settings').upsert(
    { key, value: payload.value as never },
    { onConflict: 'key' },
  );
  if (error) return new NextResponse(error.message, { status: 500 });

  return NextResponse.json({ ok: true, key, value: payload.value });
}
