'use client';

/**
 * One row of the manual queue.
 *
 * "Copy and open" is the product. Every listing has to be submitted by hand, so
 * the whole value of this page is getting that to under ten seconds: the draft
 * lands on the clipboard and the listing opens in a tab, in one action.
 *
 * The button reports what actually happened. Clipboard access can be refused by
 * the browser, and a silent failure here means pasting the previous listing's
 * letter into this employer's form.
 */

import { useState } from 'react';

type Props = {
  id: string;
  score: number | null;
  company: string | null;
  title: string;
  url: string;
  source: string;
  applyMethod: string | null;
  caseStudy: string | null;
  comp: string | null;
  location: string | null;
  discoveredAt: string;
  reason: string | null;
  flags: string[];
  /** Null until the drafter exists. The button says so rather than copying nothing. */
  draft: string | null;
};

function age(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return 'just posted';
  if (h < 48) return `${Math.round(h)}h old`;
  return `${Math.round(h / 24)}d old`;
}

export function QueueRow(p: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'nodraft' | 'failed'>('idle');

  async function copyAndOpen() {
    if (p.draft === null) {
      setState('nodraft');
      window.open(p.url, '_blank', 'noopener');
      return;
    }
    try {
      await navigator.clipboard.writeText(p.draft);
      setState('copied');
      window.open(p.url, '_blank', 'noopener');
    } catch {
      // Never leave this ambiguous — a stale clipboard means the wrong letter.
      setState('failed');
    }
  }

  return (
    <div className="queue-row">
      <div className="queue-score num">{p.score ?? '—'}</div>
      <div className="queue-body">
        <div className="queue-title">
          {p.title}, {p.company ?? 'unknown company'}
        </div>
        <div className="muted queue-meta">
          {p.source} · {age(p.discoveredAt)}
          {p.caseStudy !== null && <> · leads with {p.caseStudy}</>}
          {p.comp !== null ? <> · {p.comp}</> : <> · no pay stated</>}
          {p.location !== null && <> · {p.location}</>}
        </div>
        {p.reason !== null && <div className="muted queue-reason">{p.reason}</div>}
        {(p.applyMethod === 'email' || p.flags.length > 0) && (
          <div className="queue-flags">
            {/* The only apply path a machine can use, so it is the one worth
                calling out. Every other row resolves to an ATS endpoint or a form
                behind a key the employer holds. applyMethod was a declared prop
                that nothing rendered until the first email row existed. */}
            {p.applyMethod === 'email' && <span className="pill pill-email">email</span>}
            {p.flags.map((f) => (
              <span className="pill" key={f}>
                {f}
              </span>
            ))}
          </div>
        )}
        {state === 'copied' && <div className="ok queue-status">Draft copied. Paste it into their form.</div>}
        {state === 'nodraft' && (
          <div className="warn queue-status">
            No draft yet — the drafter is not built. Listing opened anyway.
          </div>
        )}
        {state === 'failed' && (
          <div className="err queue-status">
            Clipboard refused by the browser. Copy the draft manually before applying.
          </div>
        )}
      </div>
      <div className="queue-actions">
        <button className="primary" onClick={copyAndOpen}>
          Copy and open
        </button>
        <a className="button-link" href={p.url} target="_blank" rel="noreferrer">
          Listing
        </a>
      </div>
    </div>
  );
}
