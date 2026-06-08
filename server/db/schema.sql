-- Beacon Agent — Supabase schema.
-- Run this in Supabase → SQL Editor before using SUPABASE_* env vars.

create table if not exists public.beacon_runs (
  id            uuid primary key default gen_random_uuid(),
  topic         text not null,
  brand         text,
  report        text,
  social_posts  jsonb,
  sources       jsonb,
  whatsapp      jsonb,
  providers     jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists beacon_runs_created_at_idx
  on public.beacon_runs (created_at desc);

-- The server uses the service-role key, which bypasses RLS. If you instead
-- expose this table to the anon key, add policies explicitly.
alter table public.beacon_runs enable row level security;
