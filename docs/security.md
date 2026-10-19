# Security

Whoever can use the page can drive Claude, and Claude can run commands on
your computer. So seraph is built around one question: who counts as a member,
and can anyone else reach your data or your machine?

## Who can do what

| Who | Can |
| --- | --- |
| A **member**: signed in, and on the list `seraph user add` keeps | Read every session, send messages and keys, start sessions in any folder, delete ended sessions |
| Someone **signed in but not a member** | Nothing. The page says so. |
| Anyone with only the **publishable key** (it's in the page) | Nothing: every table is members-only, and so is the terminal stream |
| **seraph on your computer** (controller, wrapper, hooks) | Everything, with the secret key |

- **Sign-in** is by a code sent to your email. Sign-ups are off, so only
  accounts made with `seraph user add` can get a code. `seraph user remove`
  deletes the account and signs out its devices.
- **The secret key** lives only in `~/.seraph/config.json` (readable only by
  you). It's never sent to the page, and it isn't put in Claude's
  environment, where every command Claude runs could read it.
- **The terminal stream** goes over private Realtime channels that only
  members can join. Supabase accepts broadcasts sent with the publishable
  key but never delivers them, so nobody can fake what your terminal shows.
- **Starting sessions:** the controller checks the name, model, permission
  mode and session id the page sends against strict patterns, so none of them
  can be read as an extra flag on Claude's command line.

## What's stored, and for how long

| What | Where | Kept |
| --- | --- | --- |
| Transcripts, hook events (including tool inputs and outputs) | Supabase | Only the newest 50 of each per session. All of it goes an hour after the session ends |
| Ended sessions (name, folder, status) | Supabase `sessions` | 7 days, so they can still be found and resumed |
| Messages and keys sent from the page, folder listings | Supabase `commands` | An hour after they're done; a day if nobody picks them up |
| Images attached on the page | `~/.seraph/uploads/<session>` on your computer. The copy in Supabase is removed once it's saved. | Until the session is deleted |
| Sign-in sessions | The browser, per device | Until you sign out or your account is removed |
| Push addresses for phones that turned on notifications | Supabase `push_subscriptions`, each member sees only their own | Until that device signs out, or the push service says it's gone |

seraph is a controller, not an archive. Claude's full transcript stays on
your computer, where Claude keeps it; the copy in Supabase is just enough
for the page, and the controller purges the rest every minute. Even so,
recent lines can hold anything Claude read: source code, file contents,
and any secrets in them. Use a Supabase project only you control.

## Push notifications

The controller sends **empty** Web Push messages, signed with a key it keeps
in `~/.seraph/vapid.pem` (readable only by you). The phone shows a generic "a
session needs you or has finished", so nothing about your sessions passes
through Google's, Apple's or Mozilla's push service. The controller only
contacts those services' addresses, so a stored address can't make your
computer call anywhere else. Push services see the contact address in the
signature: the first member's email, or the `push_contact` setting.

## Known limits

- **Local Supabase must stay on your machine.** It uses Supabase's
  well-known local keys and the database password `postgres`. `seraph setup
  --local` binds its ports to 127.0.0.1 and `seraph doctor` checks it stays
  that way; see [Supabase](supabase.md#option-1-local-in-docker).
  It's only reachable from this computer, which is also why the hosted
  setup needs a hosted project.
- **Deleted rows' ids:** Supabase's Realtime doesn't apply row rules to
  delete events, so anyone connected with the publishable key can see the
  id of a row when it's deleted (a session's id, a message number). No
  content is sent.
- **Members are trusted completely.** There are no roles. Only add
  accounts you'd trust with a terminal on your computer.
- **The page isn't hardened for the open internet** (no rate limiting
  beyond Supabase's own). Keep it on your tailnet.

## Reporting a problem

Open an issue, or for anything sensitive, email the maintainer instead of
posting details publicly.
