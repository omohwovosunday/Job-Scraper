# job-scraper

A sourcing and application pipeline for remote design and design-engineering roles.
Polls job boards and ATS company boards, deduplicates, scores each listing for fit,
drafts a tailored application, and either queues it for review or sends it.

TypeScript worker on GitHub Actions, Postgres on Supabase, Next.js dashboard on
Vercel.

## Status

Under construction, in build order. Currently at step 6 of 10.

| Step | | |
|---|---|---|
| 1 | Repo, gitignore, TypeScript scaffold | done |
| 2 | Supabase schema, knowledge seeding | done |
| 3 | Ingest: RemoteOK, with dedupe verified | done |
| 4 | Ingest: Greenhouse company boards | done |
| 5 | Apply-path resolver and classification | done |
| 6 | Scorer, dry run — **review gate** | code done, needs API key |
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
- Row-level security is enabled on every table with no permissive policies, so the
  anon key grants nothing. The worker uses the service role key, which bypasses
  RLS; the dashboard queries server-side with it. Never expose it to a browser
  bundle.
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

Adding the aggregators bore that out. Across 1,617 rows from four sources:

| Source | Rows | Pass the pre-filter | Claim worldwide eligibility |
|---|---|---|---|
| Greenhouse (8 boards) | 1,293 | 29 | 1 |
| Himalayas | 194 | 9 | 2 |
| RemoteOK | 99 | 8 | 0 |
| We Work Remotely | 31 | 14 | 12 |

We Work Remotely has the fewest rows and the most usable ones — 31 listings, every
one of them `Anywhere in the World`, against one worldwide role in Greenhouse's
1,293. Himalayas has the best-structured data anywhere in the system
(`locationRestrictions` as an array where empty genuinely means unrestricted,
`timezoneRestrictions` as UTC offsets, real structured salary), but its feed has no
working category filter and a fixed 20-row page, so only the most recent 200
postings are read per run and few are design roles.

Two caveats found by cross-checking sources against each other:

- **`<region>` on We Work Remotely is not authoritative.** GitLab's "AI
  Transformation Owner, Product & Design" is `Anywhere in the World` there and
  `Remote, Canada; Remote, United Kingdom; Remote, United States` on GitLab's own
  Greenhouse board. The field is filled in by whoever posted the ad and errs
  optimistically, which is the direction that turns a hard zero into an apparent
  match.
- **Cross-source dedupe misses company-name variants.** "Interaction Design
  Foundation" and "IxDF - Interaction Design Foundation" are the same employer and
  hash differently, so three IxDF roles exist twice. Only 3-4 genuine duplicates
  exist across 1,617 rows, but they land disproportionately in the slice that
  matters. See the note on `dedupeHash` — the guarantee belongs at the send gate,
  not at ingest.

## Sources evaluated and rejected

Measured on 2026-09-13, so nobody repeats the work. The benchmark throughout is
We Work Remotely: 31 rows, 14 pre-filter survivors, 12 claiming worldwide
eligibility.

| Source | Sampled | Design roles | Worldwide | Email apply | Verdict |
|---|---|---|---|---|---|
| Reddit (6 subs, RSS) | 175 posts | 26 | — | **0** | rejected |
| Hacker News "Who is hiring" | 260 posts | 10 | 5 (none design) | 68 (26%) | rejected |
| Arbeitnow | 250 jobs | 10 | 0 | — | rejected |
| Jobicy | 50 jobs | 2 | 0 | — | rejected |
| Working Nomads | 44 jobs | 0 | — | — | rejected |
| Remotive | 16 jobs | 0 | — | — | rejected |

**Reddit** was proposed because its posts supposedly carry direct emails, which
would have moved the automated channel off zero. Across three runs, 26
design-relevant hiring posts carried zero email addresses; 46% said "DM me",
which is not automatable. The rates settle it independently — r/designjobs is a
freelance micro-gig market ($400 logos, $100-200 game icons), not a job board.

**Hacker News** is the only source found with a real email rate: 26% of posts
carry an address, against zero everywhere else. But it is an engineering board.
Ten design roles in 260 posts, exactly one with an email, and that one is
US-based. The five posts that are both worldwide-eligible and contactable are all
backend or platform engineering.

That is the pattern worth remembering: **email apply paths cluster in
engineering-centric US communities, and design roles go through applicant
tracking systems.** Adding more general remote boards does not change it —
Arbeitnow is a German board of mostly onsite roles, Jobicy's design roles were
Canada-only, and the other two returned no design roles at all.

The lever is not more platforms. It is the company watchlist: each
globally-hiring employer added to it is a direct, permanent increase in eligible
roles, and Workable and Recruitee already have 14 resolved companies waiting for
an adapter — including Automattic, Doist and Toggl.

## What the resolver found, and what it means for automation

Classifying all 1,392 rows produced:

| Apply method | Count | Routes to |
|---|---|---|
| `ats` | 1,293 | manual queue |
| `form` | 99 | manual queue |
| `email` | **0** | would be automated |

Email is the only automated send channel, so the pipeline can automate zero
applications. Every row goes to the manual queue.

**This was tested, not assumed.** The hypothesis was that aggregators surfacing
smaller companies would yield `mailto:` apply addresses and move `email` off zero.
We Work Remotely and Himalayas were added specifically to find out. They did not:
all three aggregators keep the employer's apply path behind their own page —
RemoteOK by obfuscating the outbound link in JavaScript, the other two by returning
403 to non-browser agents. That click is their business model. Their feeds are the
interface they publish for machines, and those work fine; spoofing a browser user
agent to read the HTML anyway would be evading an access control, not using a
public API.

Combined with ATS endpoints requiring an employer-held key, there is no automated
application path available from any source we have. So this is an assistant, not an
autonomous sender: discovery, scoring and drafting, with the dashboard's one-click
assist — copy the letter, open the apply URL — carrying the last step in under ten
seconds. The outreach track remains the only genuinely automatable channel, because
it is email by construction.

## The pre-filter, and why it exists

Nothing reaches the model until the cheap checks have run. Over 2,557 listings
from six sources and 46 ATS boards:

| | Rows |
|---|---|
| No design signal in the title | 1,364 |
| Region excluded by the employer's own location field | 882 |
| Hybrid or onsite by the location field | 225 |
| **Reach the scorer** | **86** |

Nine API calls instead of 256. Spending a model call to rediscover that "Remote -
United States" excludes a Lagos applicant is spending money to read a field the
employer already filled in.

The bar for excluding something here is deliberately high, because a pre-filter
mistake is invisible — the row is marked skipped and nobody looks at it again. So
it acts only on explicit statements, and everything ambiguous goes through to the
scorer, which has `region_ambiguous` for exactly that. An empty location field
always passes. So does a bare city name: "Toronto" does imply Canada, but a
half-complete list of world cities would exclude the ones it knows and pass the
rest, which is inconsistency with no upside.

Audited against the live corpus for false exclusions — design-titled rows dropped
as role mismatches, region exclusions on fields that also name an including region,
onsite exclusions on remote-anywhere roles. All three came back zero.

Descriptions are truncated head-and-tail rather than head-only. Eligibility lines
sit at the *foot* of a long listing, after the benefits and the EEO boilerplate,
and the longest description seen ran to 18,894 characters against a 4,000 budget.
A head-only cut would discard the sentence that decides the hard zero.

## What each source is actually for

Measured across 2,557 rows, the sources do different jobs and the numbers are not
close:

| Source | Rows | Comp stated | Pre-filter survivors | Claim worldwide |
|---|---|---|---|---|
| Greenhouse (22 boards) | 1,754 | 0% | 46 | 1 |
| Ashby (21 boards) | 401 | **58%** | 9 | 0 |
| Himalayas | 203 | 37% | 9 | 2 |
| RemoteOK | 99 | 13% | 8 | 0 |
| Lever (3 boards) | 69 | 0% | 3 | 0 |
| We Work Remotely | 31 | 0% | **14** | **12** |

Two sources earn their place for opposite reasons. **Ashby is the compensation
source** — 234 of the 323 comp-stated rows in the whole database come from it, and
without it `below_rate` and the tiered junior floor would never fire at all. It
contributes almost nothing to the eligible pool, because its companies are mostly
US or EU restricted.

**We Work Remotely is the eligibility source.** Thirty-one rows, the smallest feed
by an order of magnitude, and twelve of the seventeen roles that claim worldwide
eligibility. Its `<region>` field is poster-supplied and errs optimistically, so
treat "Anywhere in the World" as a claim to check rather than a guarantee — but on
volume-to-usefulness it beats everything else here combined.

Greenhouse is breadth. 1,754 rows for one worldwide-eligible role is the ratio the
first watchlist measurement found, and adding fourteen more boards did not change
it. It costs nothing to poll and the pre-filter discards the rest for free.

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
