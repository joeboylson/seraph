-- What Claude's status line reports for a `seraph claude` session: context
-- used, and the plan's 5-hour and weekly limits (percent used, reset time).
alter table public.sessions add column usage jsonb;
