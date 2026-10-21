-- A name for each computer, set on the page ("Atlas Mac" for atlas.local);
-- its id stays what sessions point at. And whether its controller installs
-- new releases by itself. A controller's check-ins don't touch either.
alter table public.controllers add column label text, add column auto_update boolean not null default false;
