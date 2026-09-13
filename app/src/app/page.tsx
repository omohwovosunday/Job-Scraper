/**
 * app/src/app/page.tsx
 *
 * The operations dashboard. Server component — every query runs with the service
 * role, which must never reach a browser.
 *
 * Ordered by what you need to know first when you open it: is anything broken,
 * then what is the pipeline doing, then the analytics that let you tune it.
 */

import {
  daily,
  flagsOf,
  health,
  loadOpportunities,
  loadSettings,
  medianHoursToApply,
  replyRateByCaseStudy,
  replyRateByScoreBand,
  replyRateBySource,
  type Opportunity,
  type Rate,
} from '@/lib/metrics';
import { KillSwitch } from './kill-switch';

// Live operational data. Never cache, never prerender.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function pct(r: number | null): string {
  return r === null ? '—' : `${(r * 100).toFixed(0)}%`;
}

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const mins = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function RateTable({ title, rows, note }: { title: string; rows: Rate[]; note: string }) {
  const anySent = rows.some((r) => r.sent > 0);
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {!anySent ? (
        <p className="empty">
          Nothing sent yet. {note}
        </p>
      ) : (
        <table>
          <thead>
            <tr><th>{title.split(' by ')[1] ?? ''}</th><th className="num">sent</th><th className="num">replied</th><th className="num">rate</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className="num">{r.sent}</td>
                <td className="num">{r.replied}</td>
                <td className="num">{pct(r.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default async function Page() {
  const [rows, settings, h] = await Promise.all([loadOpportunities(), loadSettings(), health()]);

  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);

  const sent = rows.filter((r) => r.sent_at !== null);
  const replied = rows.filter((r) => r.replied_at !== null);
  const queue = rows.filter((r) => r.status === 'scored' || r.status === 'queued');
  const days = daily(rows, 14);
  const maxDay = Math.max(1, ...days.map((d) => Math.max(d.discovered, d.scored, d.sent)));
  const median = medianHoursToApply(rows);

  const dryRun = settings['dry_run'] === true;
  const killed = settings['kill_switch'] === true;
  const broken = h.staleStages.length > 0 || h.recentFailures.length > 0;

  return (
    <>
      <h1>job-scraper</h1>
      <p className="sub">
        {rows.length.toLocaleString()} listings · {byStatus.get('skipped') ?? 0} filtered out ·{' '}
        {queue.length} in the queue · {sent.length} applications sent
      </p>

      {killed && (
        <div className="banner err">
          <strong>Kill switch is ON.</strong> Every stage exits immediately without doing anything.
        </div>
      )}
      {broken ? (
        <div className="banner err">
          <strong>Something is wrong.</strong>{' '}
          {h.staleStages.length > 0 && <>No recent run: {h.staleStages.join(', ')}. </>}
          {h.recentFailures.length > 0 && <>{h.recentFailures.length} recent stage failure(s).</>}
        </div>
      ) : (
        <div className="banner ok">
          All stages have run recently and none failed.
          {dryRun && ' Dry run is on, so nothing is being sent.'}
        </div>
      )}

      <h2>Health</h2>
      <div className="grid cols-2">
        <div className="panel">
          <table>
            <thead><tr><th>stage</th><th>last run</th><th>outcome</th></tr></thead>
            <tbody>
              {['ingest', 'process', 'outreach', 'followup'].map((stage) => {
                const last = h.lastRun[stage];
                return (
                  <tr key={stage}>
                    <td>{stage}</td>
                    <td className="muted">{ago(last?.started_at)}</td>
                    <td className={last === undefined ? 'muted' : last.ok === false ? 'err' : last.ok ? 'ok' : 'warn'}>
                      {last === undefined ? 'never run' : last.ok === false ? `failed: ${(last.error ?? '').slice(0, 60)}` : last.ok ? 'ok' : 'running'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="panel">
          {h.openAlerts.length === 0 ? (
            <p className="empty">No alerts raised.</p>
          ) : (
            <table>
              <thead><tr><th>alert</th><th>when</th></tr></thead>
              <tbody>
                {h.openAlerts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <span className={a.severity === 'error' ? 'err' : a.severity === 'warn' ? 'warn' : 'muted'}>
                        {a.severity}
                      </span>{' '}
                      {a.subject}
                      {a.suppressed_since_last > 0 && (
                        <span className="muted"> (+{a.suppressed_since_last} suppressed)</span>
                      )}
                    </td>
                    <td className="muted">{ago(a.sent_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {h.suppressedCount > 0 && (
            <p className="muted" style={{ marginBottom: 0 }}>
              {h.suppressedCount} occurrence(s) currently suppressed by the alert cooldown.
            </p>
          )}
        </div>
      </div>

      <h2>Controls</h2>
      <KillSwitch
        killSwitch={killed}
        dryRun={dryRun}
        dailySendCap={typeof settings['daily_send_cap'] === 'number' ? (settings['daily_send_cap'] as number) : 0}
        alertsEnabled={settings['alerts_enabled'] !== false}
      />

      <h2>Last 14 days</h2>
      <div className="panel scroll">
        <table>
          <thead>
            <tr><th>day</th><th className="num">discovered</th><th className="num">scored</th><th className="num">sent</th><th className="num">replied</th><th style={{ width: '42%' }}>discovered</th></tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td className="muted">{d.day}</td>
                <td className="num">{d.discovered || ''}</td>
                <td className="num">{d.scored || ''}</td>
                <td className="num">{d.sent || ''}</td>
                <td className="num">{d.replied || ''}</td>
                <td><div className="bar" style={{ width: `${(d.discovered / maxDay) * 100}%` }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Outcomes</h2>
      <div className="grid cols-4">
        <div className="panel">
          <div className="stat">{sent.length}</div>
          <div className="stat-label">applications sent</div>
        </div>
        <div className="panel">
          <div className="stat">{pct(sent.length === 0 ? null : replied.length / sent.length)}</div>
          <div className="stat-label">reply rate</div>
        </div>
        <div className="panel">
          <div className="stat">{median === null ? '—' : `${median.toFixed(1)}h`}</div>
          <div className="stat-label">median discovery to apply</div>
        </div>
        <div className="panel">
          <div className="stat">{queue.length}</div>
          <div className="stat-label">awaiting action</div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 12 }}>
        <RateTable
          title="Reply rate by score band"
          rows={replyRateByScoreBand(rows)}
          note="This is the breakdown that tells you whether the threshold is in the right place — if the band below the threshold replies as often as the band above, you are discarding good applications."
        />
        <RateTable
          title="Reply rate by case study"
          rows={replyRateByCaseStudy(rows)}
          note="Which of the four case studies actually works. Without this you are guessing which project to lead with."
        />
      </div>
      <div className="grid cols-2" style={{ marginTop: 12 }}>
        <RateTable
          title="Reply rate by source"
          rows={replyRateBySource(rows)}
          note="Whether a source earns its place in outcomes rather than row counts."
        />
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Pipeline</h2>
          <table>
            <tbody>
              {[...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([status, n]) => (
                <tr key={status}>
                  <td>{status}</td>
                  <td className="num">{n.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h2>Queue — {queue.length} awaiting action</h2>
      <Queue rows={queue} />
    </>
  );
}

/**
 * The manual queue. Every row lands here: ATS endpoints need an employer-held key
 * and the aggregators hide the outbound apply link, so there is no automated
 * application path from any source. The one-click assist is the product — copy the
 * letter, open the listing, under ten seconds per application.
 */
function Queue({ rows }: { rows: Opportunity[] }) {
  if (rows.length === 0) {
    return (
      <div className="panel">
        <p className="empty">
          Nothing queued. Listings arrive here once they score at or above the threshold.
        </p>
      </div>
    );
  }
  return (
    <div className="panel scroll">
      <table>
        <thead>
          <tr>
            <th className="num">score</th><th>role</th><th>location</th><th>comp</th>
            <th>material</th><th>apply</th><th></th>
          </tr>
        </thead>
        <tbody>
          {rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((r) => (
            <tr key={r.id}>
              <td className="num"><strong>{r.score ?? '—'}</strong></td>
              <td>
                <strong>{r.company ?? 'unknown'}</strong> — {r.title}
                {r.score_reason && <div className="muted">{r.score_reason}</div>}
                {flagsOf(r).length > 0 && (
                  <div style={{ marginTop: 3 }}>
                    {flagsOf(r).map((f) => <span key={f} className="pill" style={{ marginRight: 4 }}>{f}</span>)}
                  </div>
                )}
              </td>
              <td className="muted">{r.location ?? '—'}</td>
              <td className="muted">{r.comp_raw ?? '—'}</td>
              <td className="muted">{r.resume_variant ?? '—'}<br />{r.case_study_used ?? '—'}</td>
              <td><span className="pill">{r.apply_method ?? '—'}</span></td>
              <td><a href={r.url} target="_blank" rel="noreferrer">open</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
