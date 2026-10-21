-- Removes everything csc added to a Supabase project. Run it in the SQL
-- editor (or with psql). The data goes with it. Accounts made with
-- `csc user add` stay; delete them under Authentication if you like.
drop trigger if exists events_apply_to_session on public.events;
drop function if exists public.apply_event_to_session();
drop policy if exists "members listen" on realtime.messages;
drop table if exists public.sent_alerts, public.logs, public.push_subscriptions, public.messages, public.commands, public.events, public.sessions, public.controllers cascade;
drop function if exists public.csc_purge(int);
drop function if exists public.is_member();
drop table if exists public.members, public.csc_secrets;
delete from supabase_migrations.schema_migrations
  where version in ('20261017000000', '20261018000000', '20261018000100', '20261018000200', '20261018000300', '20261018000400', '20261018000500', '20261018000600', '20261019000000', '20261019000100', '20261020000000', '20261020000200', '20261021000000', '20261021000100', '20261021000200', '20261021000300');
