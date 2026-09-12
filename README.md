# job-scraper

A sourcing and application pipeline for remote design and design-engineering roles.
Polls job boards and ATS company boards, deduplicates, scores each listing for fit,
drafts a tailored application, and either queues it for review or sends it.

TypeScript worker on GitHub Actions, Postgres on Supabase, Next.js dashboard on
Vercel.

## Status

Under construction, in build order. Currently at step 3 of 10.

| Step | | |
|---|---|---|
| 1 | Repo, gitignore, TypeScript scaffold | done |
| 2 | Supabase schema, knowledge seeding | done |
| 3 | Ingest: RemoteOK, with dedupe verified | code done, DB check pending |
| 4 | Ingest: Greenhouse company boards | code done, DB check pending |
| 5 | Apply-path resolver and classification | next |
| 6 | Scorer, dry run — **review gate** | |
| 7 | Drafter, dry run — **review gate** | |
| 8 | Dashboard: queue, sent log, kill switch | |
| 9 | First live sends — **review gate** | |
| 10 | Remaining sources, follow-ups, metrics | |

Nothing sends. `dry_run` defaults to true and `kill_switch` is checked at the top of
every stage.

## Layout

```
worker/
  sources/     board adapters, one file per source
  resolve/     apply-path resolution
  llm/         scorer, drafter, prompt templates, config
  submit/      send adapters
  outreach/    cold outreach sequencer
  lib/         db client, env, settings, knowledge loader
  index.ts     stage entrypoints
knowledge/     gitignored — see knowledge/README.md
supabase/
  migrations/
scripts/
```

## Setup

Node 20.

```bash
npm install
cp .env.example .env.local   # then fill it in
```

Apply `supabase/migrations/0001_init.sql` in the Supabase SQL editor, place the
knowledge files under `knowledge/` (see `knowledge/README.md`), then:

```bash
npm run seed:knowledge
npm run typecheck
```

## Notes on this repo being public

- `/knowledge` is gitignored. The profile and case studies live in the Supabase
  `knowledge` table and are fetched at run time.
- Rate floors and the score threshold are read from the environment with no
  committed defaults. The worker fails at startup if they are unset.
- Row-level security is enabled and forced on every table with no permissive
  policies, so the anon key grants nothing. The worker uses the service role key;
  the dashboard queries server-side with it. Never expose it to a browser bundle.
- Secrets live in GitHub Actions secrets and Vercel env vars. Never committed.

## Sourcing, and what the first measurement showed

Two kinds of source. Aggregators (RemoteOK, and later We Work Remotely and
Himalayas) give breadth. Greenhouse company boards give speed, because postings
appear on a company's own board before they propagate anywhere else. The read APIs
are public and keyless; only the *application* endpoints are gated, which is why
discovery uses them and submission does not.

The first pass over the starter watchlist produced a number worth stating plainly.
Across eight boards and 1,378 open roles, 47 were design roles by title and **one**
was plausibly eligible for a Lagos-based applicant. The other 46 were US-or-Canada
only, hybrid, onsite, or tied to a specific other country — hard zeros on
eligibility regardless of how well the work fits.

The conclusion is not that the pipeline is broken. It is that picking companies by
name optimises for the wrong variable. A watchlist should be built from employers
who hire globally by policy, and eligibility filtering should happen before an LLM
is ever asked to score anything, since `location.name` on a Greenhouse posting
already says "Remote - United States" in structured form.

## Email

Three senders behind one `send()` function, resolved per channel. Not three
codepaths.

| Sender | Transport | Used for |
|---|---|---|
| `application` | Gmail SMTP, `smtp.gmail.com:587` STARTTLS | job applications, plain text, resume attached |
| `outreach` | Zoho Mail Lite, `smtp.zoho.com:465` SSL | cold outreach from a separate warmed domain |
| `system` | ZeptoMail API | run failures, cap hits, reply notifications |

Applications send from the owner's real Gmail address because it has to match the
resume and LinkedIn or it reads as spam. Outreach sends from a separate domain so
that if its reputation burns, real correspondence is unaffected. Caps are per
sender, not global.

No tracking pixels, no link shorteners, no HTML on `application` or `outreach`.
Outreach bodies carry a real unsubscribe line. Every application and outreach send
writes its full body to `sent_log` before returning.

Delivery has no webhooks over SMTP, so bounces are read back from the outreach
mailbox over IMAP, and a rolling 7-day bounce rate above 3% trips the kill switch
on that channel without waiting for anyone to notice.

## Scope

No LinkedIn or Upwork automation — their terms prohibit it.

No automated completion of assessments or AI interviews. Discovery and alerting
only; a human does the assessment.

No ATS form submission. Greenhouse, Lever, Ashby and Workable all gate their
application endpoints behind an employer-held API key that an applicant cannot
obtain, so `apply_method = 'ats'` routes to the manual queue and email is the only
automated channel. Their *read* APIs are public and keyless, which is why company
boards are polled directly for discovery.
