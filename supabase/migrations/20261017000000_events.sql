-- One row per Claude Code hook call.
create table public.events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  session_id text not null,
  hook_event text not null,
  cwd text,
  payload jsonb not null
);

create index events_session_created_idx on public.events (session_id, created_at);

-- Local only: anyone with the public key can read and write.
-- Replace with per-user policies before this leaves the machine.
alter table public.events enable row level security;
create policy "local anon insert" on public.events for insert to anon with check (true);
create policy "local anon select" on public.events for select to anon using (true);

alter publication supabase_realtime add table public.events;
