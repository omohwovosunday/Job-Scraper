-- 0002_seed_company_watchlist.sql
--
-- Starter watchlist. Every token below was verified against the live Greenhouse
-- read API on 2026-09-12 and returned 200 with a job count. Unverified tokens
-- return 404 and silently earn a row in last_poll_error, so check before adding:
--
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     https://boards-api.greenhouse.io/v1/boards/<token>/jobs
--
-- Companies that do NOT use Greenhouse, checked and rejected: notion, zapier,
-- retool, ramp, plaid, posthog, sentry, replit, canva, miro, deel, doist, loom,
-- render, railway, supabase, linear. Several use Ashby or Lever, so they become
-- candidates once those adapters exist.
--
-- WATCHLIST YIELD, measured 2026-09-12. Read this before adding more big names.
--
-- Across all eight boards: 1,378 open roles, 47 design-ish by title, and exactly
-- ONE plausibly eligible for a Lagos-based applicant — Remote.com's Senior Product
-- Designer, scoped to EMEA, which includes Africa. The rest break down as 25
-- US-or-Canada-only, 4 hybrid or onsite, and 17 tied to a specific other country
-- (Ireland, UK, Israel, Brazil, Spain, Taiwan, Canada).
--
-- So the yield on name-brand US startups is roughly 1 in 1,400. That is not a
-- scoring problem the rubric can fix; those roles are hard zeros by eligibility no
-- matter how good the fit otherwise. Selecting companies by fame optimises for the
-- wrong thing.
--
-- What to add instead: employers that hire globally as a matter of policy. GitLab
-- and Remote.com qualify and are kept for that reason even though GitLab has no
-- design roles open right now. Vercel, Figma, Stripe, Airtable, Mercury and
-- Webflow are retained as a control group — worth watching, but do not expect
-- them to produce applications.

insert into company_watchlist (company, ats_vendor, board_token, notes) values
  ('Vercel',     'greenhouse', 'vercel',    'frontend platform; design-engineer overlap'),
  ('Figma',      'greenhouse', 'figma',     'design tooling; large design org'),
  ('Stripe',     'greenhouse', 'stripe',    'fintech; very high volume board'),
  ('Airtable',   'greenhouse', 'airtable',  'B2B SaaS; small board'),
  ('GitLab',     'greenhouse', 'gitlab',    'all-remote by policy'),
  ('Mercury',    'greenhouse', 'mercury',   'fintech; banking for startups'),
  ('Webflow',    'greenhouse', 'webflow',   'design-to-code; small board'),
  ('Remote.com', 'greenhouse', 'remotecom', 'remote employment infrastructure')
on conflict (ats_vendor, board_token) do nothing;
