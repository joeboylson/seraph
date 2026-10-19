-- The local Docker stack can stall for several seconds when the machine
-- is short on memory. Let queries wait it out instead of failing at 3s.
alter role anon set statement_timeout = '15s';
alter role authenticated set statement_timeout = '15s';
