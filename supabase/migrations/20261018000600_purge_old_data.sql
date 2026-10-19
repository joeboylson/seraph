-- csc is a controller, not an archive: keep only what the page needs right
-- now, so as little as possible sits in the database. Claude's own
-- transcript on the computer is untouched. `csc daemon` calls this every
-- minute with the secret key.
create function public.csc_purge(keep int default 50) returns void
language sql security definer set search_path = '' as $$
  -- The newest `keep` transcript lines and hook events of each session.
  delete from public.messages m
  using (select id, row_number() over (partition by session_id order by id desc) as n from public.messages) r
  where m.id = r.id and r.n > keep;

  delete from public.events e
  using (select id, row_number() over (partition by csc_session order by id desc) as n from public.events) r
  where e.id = r.id and r.n > keep;

  -- An ended session's conversation goes an hour after it ends; the row stays
  -- a week so it can still be found and resumed, then goes too (with
  -- anything left that points at it).
  delete from public.messages where session_id in (
    select id from public.sessions where status = 'ended' and ended_at < now() - interval '1 hour');
  delete from public.events where csc_session in (
    select id from public.sessions where status = 'ended' and ended_at < now() - interval '1 hour');
  delete from public.sessions where status = 'ended' and coalesce(ended_at, updated_at) < now() - interval '7 days';

  -- Finished requests hold prompts and folder listings; ones nobody picked
  -- up in a day (e.g. for a computer that's off) are dead.
  delete from public.commands where status <> 'pending' and created_at < now() - interval '1 hour';
  delete from public.commands where created_at < now() - interval '1 day';
$$;

revoke execute on function public.csc_purge(int) from public, anon, authenticated;
