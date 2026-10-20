-- Each computer's seraph log lines, uploaded by its controller about once a
-- minute, for debugging from one place. Only the secret key reads or writes
-- them (no policies); each controller deletes its own after a week.
create table public.logs (
  id bigint generated always as identity primary key,
  machine text not null,
  source text not null,            -- seraph.log | daemon.log | hooks.log
  ts timestamptz,                  -- when it was written, if the line says
  pid integer,
  line text not null,
  created_at timestamptz not null default now()
);
create index logs_machine_ts on public.logs (machine, ts);
create index logs_created_at on public.logs (created_at);
alter table public.logs enable row level security;
