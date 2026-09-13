/**
 * app/src/app/page.tsx
 *
 * The operations dashboard. Server component — every query runs with the service
 * role, which must never reach a browser.
 *
 * Ordered by what the day actually needs: what is broken, what happened today,
 * what is waiting on you, what went out, and only then the analytics. The
 * analytics are weekly reading; the queue is the daily job, so it comes first.
 */

import {
  faultConsequence,
  flagsOf,
  health,
  loadOpportunities,
  loadSettings,
  medianHoursToApply,
  replyRateByCaseStudy,
  replyRateByScoreBand,
  replyRateBySource,
  today as todayCounts,
  type Opportunity,
  type Rate,
} from '@/lib/metrics';
import { Controls } from './controls';
import { QueueRow } from './queue-row';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function pct(r: number | null): string {
  return r === null ? '—' : `${(r * 100).toFixed(0)}%`;
}

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const mins = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function Stat({ value, label, tone }: { value: string | number; label: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="stat-block">
      <div className={`stat ${tone === 'good' ? 'ok' : tone === 'bad' ? 'err' : ''}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/**
 * A ruled bar, drawn to a real scale. The reference is the highest reply rate on
 * the chart, and every row states its own figure — so a bar's length means
 * something relative to the others rather than to an arbitrary multiplier.
 */
function Bars({ rows }: { rows: Rate[] }) {
  const withData = rows.filter((r) => r.sent > 0);
  if (withData.length === 0) return null;
  const peak = Math.max(...withData.map((r) => r.rate ?? 0), 0.0001);

  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.label}>
          <div className="bar-label">{r.label}</div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${((r.rate ?? 0) / peak) * 100}%` }} />
          </div>
          <div className="bar-value">
            {r.sent === 0 ? <span className="muted">none sent</span> : `${pct(r.rate)} of ${r.sent}`}
          </div>
        </div>
      ))}
    </div>
  );
}

function Breakdown({ title, note, rows }: { title: string; note: string; rows: Rate[] }) {
  const anySent = rows.some((r) => r.sent > 0);
  return (
    <div className="breakdown">
      <div className="breakdown-title">{title}</div>
      {anySent ? <Bars rows={rows} /> : <p className="empty">{note}</p>}
    </div>
  );
}

export default async function Page() {
  const [rows, settings, h] = await Promise.all([loadOpportunities(), loadSettings(), health()]);

  const capTotal = typeof settings['daily_send_cap'] === 'number' ? (settings['daily_send_cap'] as number) : 0;
  const t = todayCounts(rows, capTotal);
  const dryRun = settings['dry_run'] === true;
  const killed = settings['kill_switch'] === true;

  const queue = rows
    .filter((r) => r.status === 'scored' || r.status === 'queued')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const sentLog = rows
    .filter((r) => r.sent_at !== null)
    .sort((a, b) => new Date(b.sent_at as string).getTime() - new Date(a.sent_at as string).getTime())
    .slice(0, 25);

  const failing = h.recentFailures[0];
  const broken = h.staleStages.length > 0 || h.recentFailures.length > 0;
  const median = medianHoursToApply(rows);

  return (
    <>
      {/* Status band. Colour appears only when the state demands it. */}
      <div className={`band ${broken ? 'band-fault' : 'band-live'}`}>
        <div className="band-head">
          <span className={`band-title ${broken ? 'err' : ''}`}>
            {broken ? (failing ? `${failing.stage} is failing` : 'A stage has not run') : 'Pipeline running'}
          </span>
          <span className="muted">
            ingest {ago(h.lastRun['ingest']?.started_at)} · process {ago(h.lastRun['process']?.started_at)}
          </span>
        </div>

        {h.staleStages.length > 0 && (
          <div className="fault">
            <div className="fault-msg">No recent run: {h.staleStages.join(', ')}.</div>
            <div className="muted">
              A stage that never starts raises no error anywhere, so this is measured by the age of
              the newest run rather than the outcome of the last one.
            </div>
          </div>
        )}

        {h.recentFailures.slice(0, 3).map((f) => (
          <div className="fault" key={f.id}>
            <div className="fault-msg">{f.error ?? 'failed with no message'}</div>
            <div className="muted">
              {f.stage}, {ago(f.started_at)}. {faultConsequence(f.stage)}
            </div>
          </div>
        ))}

        {(killed || dryRun) && (
          <p className={killed ? 'err band-note' : 'band-note muted'}>
            {killed
              ? 'Kill switch on — every stage exits immediately without doing anything.'
              : 'Dry run — drafts are written, nothing is sent.'}
          </p>
        )}
      </div>

      {/* Today */}
      <div className="today">
        <Stat value={t.sent} label="sent today" />
        <Stat value={t.replies} label="replies" tone={t.replies > 0 ? 'good' : undefined} />
        <Stat value={t.drafted} label="drafted" />
        <Stat value={t.waiting} label="waiting on you" />
        <Stat value={t.expired} label="expired unsent" tone={t.expired > 0 ? 'bad' : undefined} />
      </div>

      {/* The queue — the only part that needs a person */}
      <section>
        <div className="section-head">
          <h2>Waiting on you</h2>
          <span className="muted num">
            {t.capUsed}/{t.capTotal} sent against today&rsquo;s cap
          </span>
        </div>
        <p className="section-note">
          Most listings here have to be submitted by hand. Applicant tracking systems gate their
          application endpoints behind a key only the employer holds, and the job boards hide the
          outbound apply link. Copy puts the draft on your clipboard and opens the listing. Rows
          marked <span className="pill">email</span> are the exception: Recruitee publishes a
          per-job address, so those can be sent without you.
        </p>

        {queue.length === 0 ? (
          <div className="empty-panel">
            Queue is clear. Listings arrive here once they score at or above the threshold — ingest
            runs hourly once the schedule is switched on.
          </div>
        ) : (
          <div className="queue">
            {queue.map((r) => (
              <QueueRow
                key={r.id}
                id={r.id}
                score={r.score}
                company={r.company}
                title={r.title}
                url={r.url}
                source={r.source}
                applyMethod={r.apply_method}
                caseStudy={r.case_study_used}
                comp={r.comp_raw}
                location={r.location}
                discoveredAt={r.discovered_at}
                reason={r.score_reason}
                flags={flagsOf(r)}
                draft={null}
              />
            ))}
          </div>
        )}
      </section>

      {/* Sent */}
      <section>
        <h2>Sent</h2>
        {sentLog.length === 0 ? (
          <div className="empty-panel">
            Nothing sent yet. Applications appear here with their outcome once the drafter is built
            and dry run is switched off.
          </div>
        ) : (
          <div className="log">
            {sentLog.map((r) => (
              <div className="log-row" key={r.id}>
                <div className="muted num log-when">{ago(r.sent_at)}</div>
                <div className="log-what">
                  {r.title}, {r.company ?? 'unknown'}
                </div>
                <div className={r.replied_at !== null ? 'ok' : 'muted'}>
                  {r.replied_at !== null
                    ? 'Replied'
                    : r.outcome === 'rejected'
                      ? 'Rejected'
                      : 'No reply yet'}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Analytics — weekly reading, deliberately last */}
      <section>
        <h2>What&rsquo;s working</h2>
        <p className="section-note">
          Reply rate by score band tells you where the threshold belongs — if the band below it
          replies as often as the band above, good applications are being discarded. By case study,
          which of the four to lead with.
        </p>

        <div className="stats-row">
          <Stat value={rows.filter((r) => r.sent_at !== null).length} label="applications sent" />
          <Stat
            value={pct(
              rows.filter((r) => r.sent_at !== null).length === 0
                ? null
                : rows.filter((r) => r.replied_at !== null).length /
                    rows.filter((r) => r.sent_at !== null).length,
            )}
            label="reply rate"
          />
          <Stat value={median === null ? '—' : `${median.toFixed(1)}h`} label="discovery to apply" />
        </div>

        <Breakdown
          title="Score band"
          rows={replyRateByScoreBand(rows)}
          note="No applications sent yet, so there is nothing to compare. This is the breakdown that decides where the threshold belongs."
        />
        <Breakdown
          title="Case study used"
          rows={replyRateByCaseStudy(rows)}
          note="Nothing sent yet. Once it fills in, this says which of the four projects to lead with — currently a guess."
        />
        <Breakdown
          title="Source"
          rows={replyRateBySource(rows)}
          note="Nothing sent yet. This is how a source earns its place in outcomes rather than row counts."
        />
      </section>

      {/* Controls last: reached deliberately, not fumbled into */}
      <section>
        <h2>Controls</h2>
        <Controls
          killSwitch={killed}
          dryRun={dryRun}
          dailySendCap={capTotal}
          alertsEnabled={settings['alerts_enabled'] !== false}
        />
        <p className="section-note">
          {rows.length.toLocaleString()} listings held ·{' '}
          {rows.filter((r) => r.status === 'skipped').length.toLocaleString()} filtered out before
          scoring · {h.suppressedCount} alert occurrence(s) currently suppressed by the cooldown
        </p>
      </section>
    </>
  );
}

export type { Opportunity };
