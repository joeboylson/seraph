-- Only people on the members list can use the page. csc itself uses the
-- project's secret key, which skips these rules.
create table public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
-- No policies: only the secret key can read or change the list.
alter table public.members enable row level security;

create function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where user_id = (select auth.uid()))
$$;
revoke execute on function public.is_member() from public, anon;
grant execute on function public.is_member() to authenticated;

drop policy "local anon insert" on public.events;
drop policy "local anon select" on public.events;
drop policy "local anon delete" on public.events;

do $$
declare t text;
begin
  foreach t in array array['sessions', 'commands', 'messages', 'controllers'] loop
    execute format('drop policy "local anon all" on public.%I', t);
  end loop;
  foreach t in array array['events', 'sessions', 'commands', 'messages', 'controllers'] loop
    execute format('create policy "members" on public.%I for all to authenticated using (public.is_member()) with check (public.is_member())', t);
  end loop;
end $$;

-- The terminal stream goes over private Realtime channels. Members can listen.
create policy "members listen" on realtime.messages for select to authenticated using (public.is_member());
