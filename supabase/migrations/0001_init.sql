-- 0001_init.sql — job-scraper schema
--
-- Tables: opportunities, sent_log, prospects, settings, knowledge, company_watchlist.
--
-- Access model: the worker connects with the service_role key, which bypasses RLS.
-- RLS is nonetheless enabled on every table with NO permissive policies, so the
-- anon key grants nothing. This repo is public and a Supabase URL plus anon key is
-- not a secret; without this, every draft and sent application would be world
-- readable. The dashboard therefore reads server-side with the service role, not
-- from the browser. See the NOTE at the foot of this file.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- opportunities
-- ---------------------------------------------------------------------------

create table opportunities (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_id text,
  dedupe_hash text not null unique,   -- sha256(lower(normalised_company|title|posted_date))
  company text,
  title text not null,
  description text,
  url text not null,
  location text,
  comp_raw text,
  posted_at timestamptz,
  discovered_at timestamptz not null default now(),

  apply_method text check (apply_method in ('email', 'ats', 'form', 'unresolved')),
  apply_target text,
  ats_vendor text check (ats_vendor in ('greenhouse', 'lever', 'ashby', 'workable')),

  score int check (score between 0 and 100),
  score_reason text,
  red_flags jsonb not null default '[]'::jsonb,

  status text not null default 'new'
    check (status in ('new', 'resolved', 'scored', 'drafted',
                      'queued', 'sent', 'skipped', 'failed')),
  tier text check (tier in ('auto', 'auto_flagged', 'manual')),

  draft_subject text,
  draft_body text,
  resume_variant text,
  case_study_used text,

  sent_at timestamptz,
  replied_at timestamptz,
  outcome text check (outcome in ('no_reply', 'rejected', 'interview', 'offer')),
  error text
);

comment on column opportunities.dedupe_hash is
  'The same role appears on several boards with different ids. This is what stops three applications to one job. Company name is normalised before hashing.';

create index opportunities_status_idx on opportunities (status);
create index opportunities_discovered_at_idx on opportunities (discovered_at desc);
-- dedupe_hash already has a unique index from its constraint.

-- Every stage selects on (status, discovered_at); this serves the common queue scan.
create index opportunities_status_discovered_idx
  on opportunities (status, discovered_at desc);

-- Apply-path resolution is cached per company — one company posts many roles
-- through the same ATS.
create index opportunities_company_idx on opportunities (lower(company));

-- ---------------------------------------------------------------------------
-- sent_log — the full body of everything dispatched, kept forever
-- ---------------------------------------------------------------------------

create table sent_log (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid references opportunities (id) on delete set null,
  prospect_id uuid,                   -- FK added below, after prospects exists
  channel text not null check (channel in ('email', 'ats')),
  sender text,                        -- which identity sent it; see instructions 3.2
  to_address text,
  subject text,
  body text,
  sent_at timestamptz not null default now(),
  provider_message_id text
);

comment on table sent_log is
  'You will get a reply to something you have no memory of. Full body, always.';

create index sent_log_opportunity_idx on sent_log (opportunity_id);
create index sent_log_sent_at_idx on sent_log (sent_at desc);

-- ---------------------------------------------------------------------------
-- prospects — cold outreach track
-- ---------------------------------------------------------------------------

create table prospects (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  domain text unique,
  contact_name text,
  contact_email text,
  angle text,                         -- why them; feeds the drafter
  sequence_step int not null default 0 check (sequence_step between 0 and 3),
  last_sent_at timestamptz,
  status text not null default 'new'
    check (status in ('new', 'sequencing', 'replied', 'dead'))
);

alter table sent_log
  add constraint sent_log_prospect_id_fkey
  foreign key (prospect_id) references prospects (id) on delete set null;

create index prospects_status_idx on prospects (status);

-- ---------------------------------------------------------------------------
-- settings — runtime flags the dashboard can flip without a deploy
-- ---------------------------------------------------------------------------

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- score_threshold is deliberately NOT in this table. It is a commercial figure and
-- lives in the environment with no committed default (instructions 2.3). Everything
-- here is operational and safe to surface in a dashboard.
insert into settings (key, value) values
  ('kill_switch',    'false'::jsonb),
  ('dry_run',        'true'::jsonb),   -- flipping this to false is a deliberate act
  ('daily_send_cap', '10'::jsonb);

-- ---------------------------------------------------------------------------
-- knowledge — profile, voice standard, case studies. Canonical copy.
-- ---------------------------------------------------------------------------

create table knowledge (
  key text primary key,               -- 'profile' | 'voice-sample' | 'case-study:rentos'
  content text not null,
  updated_at timestamptz not null default now()
);

comment on table knowledge is
  'The repo is public and /knowledge is gitignored, so this table is the canonical copy. The worker fetches all rows at the start of a run and caches them in memory for its duration. Editing a case study is an update here, not a deploy.';

create or replace function set_updated_at() returns trigger
language plpgsql as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

create trigger knowledge_set_updated_at
  before update on knowledge
  for each row execute function set_updated_at();

create trigger settings_set_updated_at
  before update on settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- company_watchlist — ATS boards polled directly (instructions 3.4)
-- ---------------------------------------------------------------------------

create table company_watchlist (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  ats_vendor text not null
    check (ats_vendor in ('greenhouse', 'lever', 'ashby', 'workable')),
  board_token text not null,          -- the org slug in the public board URL
  active boolean not null default true,
  notes text,
  last_polled_at timestamptz,
  last_poll_error text,
  created_at timestamptz not null default now(),
  unique (ats_vendor, board_token)
);

comment on table company_watchlist is
  'ATS job board read APIs are public and keyless, and postings appear here before they reach the aggregators. This is where the speed advantage lives. Poll on schedule, not aggressively — there are no published limits but hammering gets you blocked.';

create index company_watchlist_active_idx on company_watchlist (active)
  where active;

-- ---------------------------------------------------------------------------
-- Row level security: on everywhere, permissive policies nowhere.
-- ---------------------------------------------------------------------------

alter table opportunities      enable row level security;
alter table sent_log           enable row level security;
alter table prospects          enable row level security;
alter table settings           enable row level security;
alter table knowledge          enable row level security;
alter table company_watchlist  enable row level security;

-- FORCE ROW LEVEL SECURITY is deliberately NOT used. Postgres skips row security
-- for roles holding BYPASSRLS, which is how Supabase's service_role works, so FORCE
-- would not change the worker's access. What FORCE does change is the table owner's
-- access — and the owner is the role the SQL editor runs as. The result would be a
-- dashboard where `select * from opportunities` returns nothing and looks broken.
-- ENABLE plus zero policies already gives the property that matters: the anon key,
-- which is public in a public repo, grants nothing at all.

-- NOTE for step 8 (dashboard)
-- No policies exist, so the anon and authenticated roles can read nothing. The
-- worker is unaffected: service_role bypasses RLS. The dashboard must therefore
-- query server-side (Next.js server components or route handlers) with the service
-- role key in a Vercel server env var — NOT a NEXT_PUBLIC_* var. If you later want
-- browser-side queries, add Supabase Auth and write per-table policies then. Do not
-- weaken this in the meantime.
