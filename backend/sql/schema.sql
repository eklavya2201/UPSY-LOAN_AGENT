-- UPSY loan agent — Postgres schema (Supabase).
--
-- Replaces four whole-file JSON stores. The problems being fixed are in
-- backend/jsonFile.js's header; the short version is that every write rewrote
-- the entire file, nothing serialised concurrent writers, and an in-memory
-- cache meant only ONE process could ever own the data — which is the thing
-- that blocks running the voice agent and the upsy.in app side by side.
--
-- ── Two shapes, deliberately ────────────────────────────────────────────────
-- Records that are small, read whole and written whole stay as JSONB. An
-- application is ~2KB and every consumer wants all of it, so splitting it into
-- twenty columns would buy nothing and cost a migration every time the branch
-- schema changes — which it does, often.
--
-- TRANSCRIPTS ARE THE EXCEPTION AND THEY ARE WHY THIS MIGRATION EXISTS.
-- Measured at ~6KB per call, and voiceAccounts.json reached 106KB in a few days
-- of testing with seven accounts. At 100 users it is megabytes, and under the
-- old store EVERY write — every mid-call extraction pass — rewrote all of it.
-- So calls and their turns are their own tables: appending a turn touches one
-- row, and reading an account no longer drags every word anyone has ever said.

create extension if not exists pgcrypto;

-- ── Applications (was data/applications.json) ───────────────────────────────
create table if not exists applications (
  lead_id      text primary key,
  status       text not null default 'in_progress',
  doc          jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- /team lists by recency and filters by status; both are index scans now
-- rather than "load every application into memory and sort".
create index if not exists applications_status_updated_idx
  on applications (status, updated_at desc);

-- The nudge sweep asks "which in-progress applications went quiet", which is
-- exactly this index rather than a full scan every minute.
create index if not exists applications_updated_idx
  on applications (updated_at desc)
  where status = 'in_progress';

-- ── Voice accounts (was data/voiceAccounts.json -> accounts) ────────────────
create table if not exists voice_accounts (
  account_id     text primary key,
  name           text not null,
  phone          text not null,
  password_hash  text not null,
  -- The five-branch loan file. JSONB because callSchema.js changes shape as the
  -- underwriting flowchart does, and a column per field would mean a migration
  -- every time a question is added.
  profile        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  last_call_at   timestamptz
);

-- Sign-in is a phone lookup, and it must be unique or two accounts can claim
-- the same number — something the JSON store could not enforce at all.
create unique index if not exists voice_accounts_phone_idx on voice_accounts (phone);

-- ── Sessions (was data/voiceAccounts.json -> sessions) ──────────────────────
create table if not exists voice_sessions (
  token       text primary key,
  account_id  text not null references voice_accounts (account_id) on delete cascade,
  expires_at  timestamptz not null
);

-- Expired sessions were swept by rewriting the whole file. Now it is one
-- delete against an index.
create index if not exists voice_sessions_expiry_idx on voice_sessions (expires_at);

-- ── Calls, and their turns ──────────────────────────────────────────────────
create table if not exists voice_calls (
  call_id        text primary key,
  account_id     text not null references voice_accounts (account_id) on delete cascade,
  started_at     timestamptz not null,
  ended_at       timestamptz,
  seconds        integer,
  ended_because  text,
  language       text
);

create index if not exists voice_calls_account_idx
  on voice_calls (account_id, started_at desc);

-- One row per spoken turn. This is the table that stops a 6KB transcript being
-- rewritten on every extraction pass.
create table if not exists voice_call_turns (
  call_id  text not null references voice_calls (call_id) on delete cascade,
  idx      integer not null,
  role     text not null check (role in ('caller', 'agent')),
  text     text not null,
  said_at  timestamptz,
  primary key (call_id, idx)
);

-- ── Reviews (was data/reviews.json) ─────────────────────────────────────────
create table if not exists voice_reviews (
  id            text primary key,
  rating        integer not null check (rating between 1 and 5),
  comment       text,
  account_id    text,
  lead_id       text,
  call_seconds  integer,
  turns         integer,
  created_at    timestamptz not null default now()
);

-- The Feedback view reads newest first, and ops only cares about 1-2 stars.
create index if not exists voice_reviews_recent_idx on voice_reviews (created_at desc);
create index if not exists voice_reviews_poor_idx on voice_reviews (created_at desc) where rating <= 2;

-- ── Callbacks (was data/callbacks.json) ─────────────────────────────────────
create table if not exists voice_callbacks (
  id          text primary key,
  name        text,
  phone       text not null,
  when_text   text,
  lead_id     text,
  account_id  text,
  handled     boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists voice_callbacks_open_idx
  on voice_callbacks (created_at desc) where handled = false;

-- Added after the first version of this file. `create table if not exists` does
-- NOT add columns to a table that already exists, so a schema change has to
-- come as its own idempotent statement or it silently does nothing on every
-- database that already ran the original.
alter table voice_callbacks add column if not exists topic  text;
alter table voice_callbacks add column if not exists status text not null default 'pending';

-- ── Row-level security ──────────────────────────────────────────────────────
-- Only this server talks to the database, never a browser, and it connects as
-- the table owner, so RLS does not apply to it. Enabling it anyway means that
-- IF someone later points a browser at Supabase with the anon key, the default
-- is "no access" rather than "everything" — the right way round for tables
-- holding applicants' documents and contact details.
alter table applications      enable row level security;
alter table voice_accounts    enable row level security;
alter table voice_sessions    enable row level security;
alter table voice_calls       enable row level security;
alter table voice_call_turns  enable row level security;
alter table voice_reviews     enable row level security;
alter table voice_callbacks   enable row level security;
