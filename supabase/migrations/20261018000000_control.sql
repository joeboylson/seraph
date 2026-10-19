-- A Claude session started through `csc claude` (or linked with `csc link`).
-- `id` is ours and survives /clear and resume; Claude's own id can change.
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  name text,
  cwd text not null,
  hostname text,
  pid int,
  mode text not null default 'wrapped',  -- wrapped | headless | linked
  claude_session_id text,
  transcript_path text,
  status text not null default 'starting',  -- starting | idle | working | waiting | ended
  permission_mode text,
  model text,
  cols int,
  rows int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);

alter table public.events add column csc_session uuid references public.sessions (id) on delete cascade;
create index events_csc_session_idx on public.events (csc_session, created_at);

-- Requests from the web page. Session commands are picked up by that
-- session's wrapper; start_session and list_dirs by `csc daemon`.
create table public.commands (
  id bigint generated always as identity primary key,
  session_id uuid references public.sessions (id) on delete cascade,
  kind text not null,  -- prompt | keys | interrupt | resize | kill | start_session | list_dirs
  payload jsonb not null default '{}',
  status text not null default 'pending',  -- pending | done | failed
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index commands_pending_idx on public.commands (session_id, id) where status = 'pending';

-- A tool call waiting on the person. The PermissionRequest hook blocks
-- until `status` leaves 'pending'.
create table public.permission_requests (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  tool_name text not null,
  tool_input jsonb not null default '{}',
  tool_use_id text,
  status text not null default 'pending',  -- pending | allowed | denied | cancelled
  response jsonb,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index permission_requests_session_idx on public.permission_requests (session_id, id);

-- The session transcript, one row per JSONL line Claude writes.
create table public.messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  uuid text not null,
  type text not null,
  ts timestamptz,
  data jsonb not null,
  unique (session_id, uuid)
);
create index messages_session_idx on public.messages (session_id, id);

-- One row per running `csc daemon`, so the page can tell it's online.
create table public.controllers (
  id text primary key,
  hostname text,
  home text,
  last_seen timestamptz not null default now()
);

-- Keep sessions.status in step with the hook events.
create function public.apply_event_to_session() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  next_status text;
begin
  if new.csc_session is null then
    return new;
  end if;
  next_status := case new.hook_event
    when 'SessionStart' then 'idle'
    when 'UserPromptSubmit' then 'working'
    when 'PreToolUse' then 'working'
    when 'PostToolUse' then 'working'
    when 'PostToolUseFailure' then 'working'
    when 'PermissionRequest' then 'waiting'
    when 'Stop' then 'idle'
    when 'StopFailure' then 'idle'
    when 'SessionEnd' then 'ended'
    when 'Notification' then case new.payload->>'notification_type'
      when 'permission_prompt' then 'waiting'
      when 'elicitation_dialog' then 'waiting'
      when 'idle_prompt' then 'idle'
      else null end
    else null
  end;
  update public.sessions set
    status = case when status = 'ended' then status else coalesce(next_status, status) end,
    claude_session_id = coalesce(new.session_id, claude_session_id),
    transcript_path = coalesce(new.payload->>'transcript_path', transcript_path),
    permission_mode = coalesce(new.payload->>'permission_mode', permission_mode),
    model = coalesce(new.payload->>'model', model),
    cwd = coalesce(new.payload->>'cwd', cwd),
    updated_at = now()
  where id = new.csc_session;
  return new;
end $$;

create trigger events_apply_to_session after insert on public.events
for each row execute function public.apply_event_to_session();

-- Local only, by choice: the public key can do everything.
do $$
declare t text;
begin
  foreach t in array array['sessions', 'commands', 'permission_requests', 'messages', 'controllers'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "local anon all" on public.%I for all to anon using (true) with check (true)', t);
    execute format('alter publication supabase_realtime add table public.%I', t);
  end loop;
end $$;
create policy "local anon delete" on public.events for delete to anon using (true);
