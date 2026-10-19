-- Which build each computer runs, so out-of-date ones can be spotted after
-- an update here.
alter table public.controllers add column version text;
