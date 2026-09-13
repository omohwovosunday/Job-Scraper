'use client';

/**
 * The one control that has to work under stress. Flipping kill_switch stops every
 * stage at its first line on the next run.
 *
 * Deliberately a plain form POST to a route handler rather than anything clever:
 * the client never touches Supabase, because the service role key is the only
 * credential that can write and it must stay server-side.
 */

import { useState, useTransition } from 'react';

type Props = {
  killSwitch: boolean;
  dryRun: boolean;
  dailySendCap: number;
  alertsEnabled: boolean;
};

export function KillSwitch(props: Props) {
  const [state, setState] = useState(props);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function set(key: string, value: unknown) {
    setError(null);
    start(async () => {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) {
        setError(`could not update ${key}: ${await res.text()}`);
        return;
      }
      setState((s) => ({ ...s, [keyToProp(key)]: value } as Props));
    });
  }

  return (
    <div className="panel">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => set('kill_switch', !state.killSwitch)} disabled={pending}>
          {state.killSwitch ? 'Kill switch is ON — turn off' : 'Stop everything (kill switch)'}
        </button>
        <button onClick={() => set('dry_run', !state.dryRun)} disabled={pending}>
          {state.dryRun ? 'Dry run ON — nothing sends' : 'Dry run OFF — sending is live'}
        </button>
        <button onClick={() => set('alerts_enabled', !state.alertsEnabled)} disabled={pending}>
          {state.alertsEnabled ? 'Alerts on' : 'Alerts off'}
        </button>
        <span className="muted">daily send cap: {state.dailySendCap}</span>
        {pending && <span className="muted">saving…</span>}
      </div>
      {error && <p className="err" style={{ marginBottom: 0 }}>{error}</p>}
      {!state.dryRun && (
        <p className="err" style={{ marginBottom: 0 }}>
          Dry run is off. Applications will be dispatched for real once a send path exists.
        </p>
      )}
    </div>
  );
}

function keyToProp(key: string): keyof Props {
  switch (key) {
    case 'kill_switch': return 'killSwitch';
    case 'dry_run': return 'dryRun';
    case 'alerts_enabled': return 'alertsEnabled';
    default: return 'dailySendCap';
  }
}
