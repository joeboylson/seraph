-- Several computers can share one project. Requests for a controller
-- (start a session, list folders) name the computer they're for, and a
-- controller claims one (pending → running) before acting, so two
-- computers never both handle it.
alter table public.commands add column target text;
create index commands_daemon_pending_idx on public.commands (target, id) where status = 'pending' and session_id is null;

-- Values every csc controller on the project shares, like the push signing
-- key, so a phone subscribed through one computer hears from all of them.
-- No policies: only the secret key can read or write it.
create table public.csc_secrets (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
alter table public.csc_secrets enable row level security;
