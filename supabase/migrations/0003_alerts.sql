-- 0003_alerts.sql
--
-- Operational alerting and the run history the dashboard reads.

-- ---------------------------------------------------------------------------
-- alert_log — what was sent, and what is being suppressed
-- ---------------------------------------------------------------------------

create table alert_log (
  id uuid primary key default gen_random_uuid(),
  -- Stable identity for a recurring condition, e.g. 'stage_failed:ingest'.
  -- Throttling is keyed on this, so it must not embed a timestamp or a row id.
  alert_key text not null,
  severity text not null default 'error' check (severity in ('info', 'warn', 'error')),
  subject text not null,
  body text not null,
  sent_at timestamptz not null default now(),
  -- How many occurrences were suppressed since the last send. A run that breaks
  -- on a 20-minute cron produces 72 identical alerts a day without this.
  suppressed_since_last int not null default 0,
  delivered boolean not null default false,
  delivery_error text
);

create index alert_log_key_sent_idx on alert_log (alert_key, sent_at desc);
create index alert_log_sent_idx on alert_log (sent_at desc);

comment on table alert_log is
  'Every alert raised, including ones suppressed by the cooldown. The dashboard reads this to show what is currently broken without waiting for the next email.';

-- ---------------------------------------------------------------------------
-- run_log — one row per stage execution
-- ---------------------------------------------------------------------------

create table run_log (
  id uuid primary key default gen_random_uuid(),
  stage text not null check (stage in ('ingest', 'process', 'outreach', 'followup')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  error text,
  -- Stage-specific counters: rows ingested, listings scored, calls made.
  stats jsonb not null default '{}'::jsonb
);

create index run_log_stage_started_idx on run_log (stage, started_at desc);
create index run_log_started_idx on run_log (started_at desc);

comment on table run_log is
  'A stage that never starts raises no error anywhere. This is how a silently dead cron becomes visible: the dashboard checks the age of the newest row, not just the outcome of the last one.';

-- ---------------------------------------------------------------------------
-- Same access model as every other table: RLS on, no policies, service role only.
-- ---------------------------------------------------------------------------

alter table alert_log enable row level security;
alter table run_log   enable row level security;

-- Alert throttling settings, flippable from the dashboard alongside the others.
insert into settings (key, value) values
  ('alerts_enabled', 'true'::jsonb),
  ('alert_cooldown_minutes', '120'::jsonb)
on conflict (key) do nothing;
