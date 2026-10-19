-- Phones that asked to be told when a session needs them. `csc daemon`
-- reads these with the secret key and sends empty Web Push messages, so
-- nothing about a session passes through the push service.
create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
-- Each member sees and manages only their own devices.
create policy "own devices" on public.push_subscriptions for all to authenticated
  using (public.is_member() and user_id = (select auth.uid()))
  with check (public.is_member() and user_id = (select auth.uid()));
