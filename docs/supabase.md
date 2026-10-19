# Connecting to Supabase

seraph keeps everything in a Supabase project: the sessions, their
transcripts, hook events, and the messages and keys the page sends. Any
Supabase works: a local one in Docker, a hosted project on supabase.com, or
a self-hosted install.

## Option 1: local, in Docker

Needs [Docker](https://docs.docker.com/get-docker/) and the
[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started).

```sh
seraph setup --local
```

This starts the Supabase stack defined in this repo's `supabase/` folder,
installs the tables, and saves the address and key to `~/.seraph/config.json`.
seraph skips the parts of Supabase it doesn't use (Studio, storage, edge
functions, logging), so it starts faster and uses less memory.

The local stack uses ports 55421–55429 so it doesn't clash with other local
Supabase projects on the default 54321–54329. Change them in
`supabase/config.toml` if you need to, then run `seraph setup --local` again.

**The local stack stays on this machine.** It uses Supabase's well-known
local keys and the database password `postgres`, so whoever can reach its
ports could read everything. Docker normally publishes a project's ports on
every network interface (anyone on the same Wi-Fi), so `seraph setup --local`
creates the stack's network first with ports bound to 127.0.0.1. `seraph doctor`
checks this. If it ever flags it, run `supabase stop`, then `seraph setup
--local`. `seraph tailscale` still works: it reaches the stack through 127.0.0.1.

Sign-in codes from a local stack aren't really emailed. They land in its
test inbox at http://127.0.0.1:55424, and `seraph user code <email>` prints a
fresh one. To get real emails, set up `[auth.email.smtp]` in
`supabase/config.toml`.

Stop it with `supabase stop` in this folder (your data is kept). `seraph setup
--local` starts it again.

## Option 2: your own project

1. Create a project at [supabase.com](https://supabase.com/dashboard), or
   use an existing one. A separate project for seraph keeps things tidy.
2. Open the project's **Connect** dialog (or **Project Settings → API**) and
   copy:
   - the **Project URL**: `https://<ref>.supabase.co`
   - the **publishable key** (`sb_publishable_…`). The older **anon** key
     works too. The page uses this one.
   - the **secret key** (`sb_secret_…`). The older **service_role** key
     works too. Only seraph and the hooks use it, and it stays on your machine.
   - the **database connection string** (the "Direct connection" URI, with
     your database password filled in). This is only used once, to install
     the tables.
3. Run:

   ```sh
   seraph setup --url https://<ref>.supabase.co --key sb_publishable_… \
             --secret-key sb_secret_… \
             --db-url 'postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres'
   ```

   Or just `seraph setup` and answer the questions.

The connection string isn't saved. Installing the tables uses the Supabase
CLI's `supabase db push` if you have it, or `psql` otherwise. If your
network can't reach the direct connection (it's IPv6-only on some plans),
use the "Session pooler" connection string instead.

Then set up sign-in, in the dashboard under **Authentication**:

- **Sign In / Providers**: turn off **Allow new users to sign up**. Leave
  the Email provider on. Accounts come from `seraph user add <email>`.
- **URL Configuration**: add the page's addresses to Redirect URLs, e.g.
  `http://127.0.0.1:8787/**` and your Tailscale one
  (`https://<machine>.<tailnet>.ts.net:8446/**`). The sign-in email's link
  comes back to the page and signs you in.
- **Emails → Magic Link** (optional): to get a code in the email as well,
  paste in `supabase/templates/magic_link.html`. On the free plan this needs
  your own SMTP server first; without it the email has only the link, which
  works too. Hosted codes are 8 digits.
- Supabase's built-in email sender only allows a few emails an hour. For
  more, add your own SMTP server under **Emails → SMTP Settings**.
  `seraph user code <email>` prints a code without sending any email.

Realtime must be on for the project (it is by default). The tables are
added to the `supabase_realtime` publication by the migration.

## Updating the tables

New versions of seraph may add migrations. Apply them with:

```sh
seraph db push                       # local
seraph db push --db-url '<connection string>'   # your own project
```

## Switching projects

Run `seraph setup` again with the new details, then `seraph restart`. Sessions
in the old project stay there.

## Where settings live

`~/.seraph/config.json` (readable only by you):

| Setting | Meaning |
| --- | --- |
| `supabase_url` | What seraph and the hooks talk to |
| `supabase_key` | The publishable or anon key, given to the page |
| `supabase_secret_key` | The secret or service_role key, used by seraph and the hooks. Never sent to the page. |
| `browser_supabase_url` | What the page uses when it's opened from another device, if different. `seraph tailscale` sets this for a local Supabase. |
| `web_port` | Where the controller serves the page (default 8787) |
| `claude_bin` | The Claude Code command (default `claude`) |

Each can be overridden per shell with `SERAPH_SUPABASE_URL`,
`SERAPH_SUPABASE_KEY`, `SERAPH_SUPABASE_SECRET_KEY`, `SERAPH_BROWSER_SUPABASE_URL`, `SERAPH_WEB_PORT` and
`SERAPH_CLAUDE_BIN`. `SERAPH_HOME` moves the folder, which is handy for running two
setups side by side.

## Removing seraph's data

Run [`supabase/uninstall.sql`](../supabase/uninstall.sql) in the SQL editor.
It drops seraph's five tables and its trigger, and nothing else.
