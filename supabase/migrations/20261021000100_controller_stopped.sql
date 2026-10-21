-- When a controller stopped cleanly; cleared while it runs. With last_seen
-- (it checks in every 10 minutes) this says whether a device is active:
-- running, and seen within the hour.
alter table public.controllers add column stopped_at timestamptz;
