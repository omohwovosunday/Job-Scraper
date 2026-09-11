# job-scraper

A sourcing and application pipeline for remote design and design-engineering roles.
Polls job boards and ATS company boards, deduplicates, scores each listing for fit,
drafts a tailored application, and either queues it for review or sends it.

TypeScript worker on GitHub Actions, Postgres on Supabase, Next.js dashboard on
Vercel.

## Status

Under construction, in build order. Currently at step 2 of 10.

| Step | | |
|---|---|---|
| 1 | Repo, gitignore, TypeScript scaffold | done |
| 2 | Supabase schema, knowledge seeding | done |
| 3 | Ingest: RemoteOK, with dedupe verified | next |
| 4 | Ingest: one Greenhouse board from the watchlist | |
| 5 | Apply-path resolver and classification | |
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

## Scope

No LinkedIn or Upwork automation — their terms prohibit it.

No automated completion of assessments or AI interviews. Discovery and alerting
only; a human does the assessment.

No ATS form submission. Greenhouse, Lever, Ashby and Workable all gate their
application endpoints behind an employer-held API key that an applicant cannot
obtain, so `apply_method = 'ats'` routes to the manual queue and email is the only
automated channel. Their *read* APIs are public and keyless, which is why company
boards are polled directly for discovery.
