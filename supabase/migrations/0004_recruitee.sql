-- 0004_recruitee.sql
--
-- Admit Recruitee to the watchlist.
--
-- Worth recording why this vendor matters more than the count of companies
-- suggests. Every Recruitee offer publishes `mailbox_email`, a per-job address
-- that routes mail into the employer's own applicant tracking system as a
-- candidate record. Across 2,557 listings from six sources, the apply path was
-- 2,224 ats and 333 form and ZERO email — and email is the only channel a machine
-- can use. Recruitee is the first and so far only source that provides one.
--
-- Workable is admitted to the enum as well, because detection can identify it and
-- the rows are worth keeping as a record of which ATS a company uses. It cannot
-- have an adapter: its only public endpoint returns an empty jobs array for every
-- account tested, including Automattic, Rippling, Navan, Vinted and Depop.

alter table company_watchlist
  drop constraint if exists company_watchlist_ats_vendor_check;

alter table company_watchlist
  add constraint company_watchlist_ats_vendor_check
  check (ats_vendor in ('greenhouse', 'lever', 'ashby', 'workable', 'recruitee'));

comment on column company_watchlist.ats_vendor is
  'greenhouse, lever, ashby and recruitee have adapters. workable is recorded for reference only — its public endpoint exposes no job listings.';
