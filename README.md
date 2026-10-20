# csc: Claude Code remote control, through Supabase

Use Claude Code on your computer from a web page on any device: read the
conversation, send messages and images, answer permission prompts, stop a
turn, start new sessions in any folder, and resume old ones. Like Claude
Code's built-in Remote Control, but on your own Supabase.

```
seraph claude ──► Claude Code (in a terminal seraph owns) ──hooks──┐
     ▲  │                                                     ▼
     │  └─ screen + transcript ──────────────────────►  Supabase  ◄──► web page
     └──── messages, keys, Esc ◄──────────────────────     (yours)      (any device)
```

You keep using Claude in your terminal exactly as before. The page is a
second window onto the same session, and either one can answer Claude.

## Quick start

You need macOS or Linux,
[Claude Code](https://docs.claude.com/en/docs/claude-code), and either Docker
with the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
or a Supabase project. Building from the repo also needs
[Rust](https://rustup.rs) and Node 18+.

```sh
curl -fsSL https://raw.githubusercontent.com/joeboylson/seraph/main/install.sh | sh
seraph setup              # connect to Supabase: local Docker, or your own project
seraph user add <email>   # let yourself sign in to the page
seraph start              # run the controller in the background
```

Then deploy the page (`web/`) to Vercel or any static host, and tell seraph
where it is with `seraph setup --page-url <address>`; see
[the page](docs/remote-access.md). `seraph open` opens it.

Then, in any project:

```sh
seraph claude             # instead of `claude`; all of Claude's flags work
```

The session shows up on the page straight away. `seraph doctor` checks every
part and says how to fix anything that isn't working.

`seraph claude` never gets in the way of using Claude: if Supabase is down it
starts Claude anyway (the session appears on the page once Supabase is
back), and if seraph isn't set up it runs plain `claude`. So it's safe to
`alias claude="seraph claude"`.

## Everyday use

| You want to | Run |
| --- | --- |
| Start Claude so the page can see and drive it | `seraph claude` (any `claude` flags) |
| Start a session from your phone | **New session** on the page |
| See recent sessions | `seraph sessions` |
| Pick one back up | `seraph resume`, or `seraph resume <part of its name or folder>` |
| Show an already-running Claude on the page (read-only) | `!seraph link` inside it |
| Check everything is running | `seraph status`, or `seraph doctor` for detail |
| Install seraph on your other computers | `seraph tailscale`. See [the page](docs/remote-access.md) |
| Start the controller at login | `seraph service install` |
| Read the logs | `seraph logs`, or `seraph logs -f` to follow |

On the page:

- Claude's questions (permission prompts, multiple choice, plan approval,
  pickers like `/model`) appear as buttons. Panels that wait for Esc (like
  `/usage`) show with a **Close** button.
- Type `/` for slash commands. Anything you type is sent as is, so your own
  commands and skills work too.
- Attach images with the image button or by pasting.
- **Stop** interrupts Claude (Esc). **Mode** cycles the permission mode
  (Shift+Tab). **End** closes the session. Ended sessions can be resumed.
- The **Terminal** tab is the real terminal. You can type into it.
- **Notify me** turns on alerts for when a session needs you or finishes,
  even with the page closed. On iPhone, add the page to your home screen
  first (Share → Add to Home Screen); Apple only allows notifications there.

## Connecting to Supabase

`seraph setup` asks which you want:

- **Local**: a Supabase in Docker, started from this repo. Nothing leaves
  your machine. Good for trying it out and for single-machine use.
- **Your own project**: hosted on supabase.com, or self-hosted. You give it
  the project URL, the publishable (or anon) key for the page, the secret
  key for seraph, and once the database connection string to install the tables.

Non-interactive versions:

```sh
seraph setup --local
seraph setup --url https://abcd.supabase.co --key sb_publishable_… --secret-key sb_secret_… \
          --db-url 'postgresql://postgres:PASSWORD@db.abcd.supabase.co:5432/postgres'
```

Settings live in `~/.seraph/config.json`. Every one can be overridden with an
environment variable (`SERAPH_SUPABASE_URL`, `SERAPH_SUPABASE_KEY`,
`SERAPH_SUPABASE_SECRET_KEY`, `SERAPH_WEB_PORT`,
`SERAPH_CLAUDE_BIN`, `SERAPH_PAGE_URL`), and `SERAPH_HOME` moves the whole
folder. Details in [docs/supabase.md](docs/supabase.md).

## Installing and updating

`seraph` is one program. Install or update it (on macOS or Linux, Apple
Silicon, Intel or ARM) with:

```sh
curl -fsSL https://raw.githubusercontent.com/joeboylson/seraph/main/install.sh | sh
```

It downloads the latest release built for the computer and checks it
against its checksum; `SERAPH_VERSION=v0.2.0` picks a release. A running
controller restarts onto the new copy; Claude sessions keep running.

From a copy of the repo, the same script builds it from the code there:

```sh
git clone https://github.com/joeboylson/seraph.git && cd seraph
./install.sh              # install, or update after a change; restarts the controller
```

Pushing a tag like `v0.3.0` builds every platform and publishes the
release ([.github/workflows/release.yml](.github/workflows/release.yml)).

On your other computers of the same kind (e.g. another Apple Silicon Mac),
install or update straight from a computer that runs the controller:

```sh
curl -fsSL https://<machine>.<tailnet>.ts.net:8446/install | sh
```

It downloads that computer's own copy, so build there first. A new device
then needs `seraph setup` once (keys never travel with the download).
`seraph status` lists each computer's build, and `seraph doctor` says when
one is behind. If an update adds tables or columns, run `seraph db push`
(or `seraph setup --local`) once.

## Several computers, one page

Every computer that runs seraph against the same Supabase project shows up on
the one page. Its sessions are listed together, and **New session** asks
which computer to start on. On each extra computer, run `seraph setup` with
the same project URL and keys (`--url`, `--key`, `--secret-key`), then
`seraph start`. This needs a hosted Supabase project, which every computer
can reach.

- Computers are told apart by hostname. Give one another name with
  `SERAPH_MACHINE=name` or `"machine"` in `~/.seraph/config.json`. Each computer
  needs its own name.
- Each request names the computer it's for, and a computer claims a request
  before acting, so two computers never both start the same session.
- Resume restarts a session on the computer it ran on, where its history is.
- Push notifications work from every computer. They share one signing key,
  kept in the project and readable only with the secret key.

## Security

The data is members-only. The publishable key alone can't read or change
anything, or listen to the terminal stream. Only signed-in users on the
`members` list can, and seraph itself uses the secret key, which stays in
`~/.seraph/config.json` and is never sent to the page.

The page signs in with a code sent by email. Sign-ups are off: only
accounts added with `seraph user add <email>` get a code, and `seraph user remove`
takes one away. With a local Supabase the codes don't leave your machine.
They land in its test inbox at http://127.0.0.1:55424, or print one with
`seraph user code <email>`. A signed-in device stays signed in until you press
the sign-out button in the page's header.

Whoever signs in can drive Claude, and Claude can run commands on your
machine, so only add accounts you trust.

[docs/security.md](docs/security.md) covers what's stored where, for how
long, and the known limits.

## Uninstall

```sh
seraph uninstall          # stop the controller, remove start-at-login and the `seraph` command
seraph uninstall --purge  # also delete ~/.seraph (settings, logs, uploaded images)
```

Your Supabase data is left alone. To remove it, run
[`supabase/uninstall.sql`](supabase/uninstall.sql) in the SQL editor, or
`supabase stop --no-backup` in this folder for the local stack. Then delete
this folder.

## More

- [Supabase setup in detail](docs/supabase.md)
- [Reaching the page from your phone](docs/remote-access.md)
- [How it works](docs/how-it-works.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development and tests](docs/development.md)
