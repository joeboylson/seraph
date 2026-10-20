-- Set when a session is paused from the page: Claude is stopped to free the
-- computer, but the session stays with the running ones until it's resumed
-- (which clears this) or ended.
alter table public.sessions add column paused_at timestamptz;
