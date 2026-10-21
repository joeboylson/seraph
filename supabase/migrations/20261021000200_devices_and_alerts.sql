-- Phones' keys for encrypted pushes (RFC 8291), so a notification can say
-- which session and why while the push service still sees nothing. Phones
-- that subscribed before these existed keep getting empty pushes.
alter table public.push_subscriptions add column p256dh text, add column auth text;

-- What each session pushes about: everything, only when it needs you or
-- finishes a long task (the default), or nothing.
alter table public.sessions add column notify text not null default 'needs-you'
  check (notify in ('all', 'needs-you', 'off'));

-- What a controller reports about its computer on each check-in: its allowed
-- folders, whether it starts at login, its platform.
alter table public.controllers add column info jsonb;

-- Alerts already sent (e.g. "5-hour limit at 80%" for one window), so several
-- computers don't each send the same one. Secret key only.
create table public.sent_alerts (
  key text primary key,
  created_at timestamptz not null default now()
);
alter table public.sent_alerts enable row level security;

-- Members can read every computer's logs, for the device screens.
create policy "members read" on public.logs for select to authenticated using (public.is_member());
