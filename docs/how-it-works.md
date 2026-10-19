# How it works

## The pieces

**`seraph claude`** starts Claude Code inside a pseudo-terminal that seraph owns,
the same trick `script` and tmux use. Everything Claude draws goes to your
terminal as normal, and is also streamed to the page over Supabase Realtime
(broadcast channel `term:<session id>`). Whatever the page sends (a
message, a key, Esc) is typed into that terminal as if you'd typed it. The
wrapper also follows Claude's transcript file
(`~/.claude/projects/…/<id>.jsonl`) and copies the conversation into the
`messages` table, and passes Claude a `--settings` file that adds hooks for
this session only.

**Hooks** (`seraph _hook`) send each hook event (session start,
prompt, tool use, permission request, stop…) to the `events` table. A
database trigger turns those into the session's status: `starting`, `idle`,
`working`, `waiting` (on you) or `ended`. Your own Claude settings and hooks
are untouched.

**`seraph daemon`**, the controller, runs in the background. It starts
sessions the page asks for (the same wrapper, with no terminal
attached), lists folders for the folder picker, checks in every 10 seconds
so the page knows it's online, and marks sessions ended if their process
dies.

**The page** (`web/`, Vite + React + shadcn) reads and writes Supabase
directly, with the project's address and publishable key built in. It's
hosted on its own (e.g. Vercel); see [the page](remote-access.md).

## Answering Claude

When Claude shows a menu (permission prompt, question, plan approval,
`/model` picker), the page reads the numbered choices off the mirrored
screen and shows them as buttons. Pressing one sends that number key, just
like pressing it in the terminal, so the terminal and the page can both
answer. Panels that wait for Esc are shown the same way with a Close
button. Claude ignores keys for a moment after showing a menu, so the
buttons wait about a second before they're enabled.

## Tables

| Table | Holds |
| --- | --- |
| `sessions` | One row per session: folder, status, Claude's session id, terminal size |
| `events` | Every hook event, with its full payload |
| `messages` | The transcript: user, assistant and system lines |
| `commands` | Requests from the page: `prompt`, `keys`, `interrupt`, `kill`, `replay`, `resize` for a session; `start_session` and `list_dirs` for the controller |
| `controllers` | One row per machine running the controller, with when it last checked in |

## Session kinds

| Kind | Started by | Page can |
| --- | --- | --- |
| `wrapped` | `seraph claude` in a terminal | everything |
| `headless` | the page (**New session**) | everything |
| `linked` | `!seraph link` inside a plain `claude` | read only. There's no terminal seraph can type into. To take control, exit and run `seraph resume`. |

## Files on your machine

| Path | What |
| --- | --- |
| `~/.seraph/config.json` | Settings |
| `~/.seraph/seraph.log`, `~/.seraph/daemon.log`, `~/.seraph/hooks.log` | Logs |
| `~/.seraph/daemon.pid` | The running controller |
| `~/.seraph/uploads/` | Images sent from the page |
| `~/.seraph/links/` | Sessions linked with `seraph link` |
| `~/Library/LaunchAgents/dev.seraph.daemon.plist` or `~/.config/systemd/user/seraph.service` | Start at login, if turned on |
