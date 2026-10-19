# Troubleshooting

Start with `seraph doctor`. It checks each part and says how to fix what's
broken. `seraph logs` shows what the controller and wrappers have been doing.

**The page says "Controller offline".**
The controller isn't running, or can't reach Supabase. Run `seraph start`,
then `seraph doctor`. To keep it running across logins, `seraph service install`.

**The page says it can't reach Supabase.**
On another device, a local Supabase at `127.0.0.1` isn't reachable. Run
`seraph tailscale`, or set `seraph setup --browser-url`. See
[remote access](remote-access.md).

**Everything is slow, or the logs say "timed out".**
Usually Docker is short on memory (a local Supabase needs about 1 GB).
Check with `docker stats`. Stop other local Supabase stacks you're not
using (`supabase stop` in their folders) or give Docker more memory. seraph
retries and catches up, so nothing is lost, just delayed.

**A session is stuck on "Starting".**
Claude is probably showing a one-off screen first (trusting a new folder,
an update notice). Open the session's **Terminal** tab and answer it.
Messages you've sent wait until Claude is ready.

**A button press on a menu didn't do anything.**
Claude ignores keys briefly after showing a menu. The card says "That
didn't go through. Try again", so press it again. Key presses that can't be
delivered within 30 seconds (Supabase was slow or down) are dropped rather
than pressed late, since by then the screen may show something else.

**The page shows a session as running, but it isn't.**
The controller marks sessions ended when their process is gone, within
about 10 seconds. If the controller isn't running, `seraph start`.

**`seraph claude` says it can't reach Supabase.**
Claude still starts and works normally in your terminal. The session
appears on the page once Supabase is reachable again. `seraph doctor` shows
what's wrong.

**`seraph claude` says it needs a terminal.**
It runs Claude interactively, so start it from a terminal. To start a
session without one, use **New session** on the page.

**`seraph db push` can't connect.**
For a hosted project, check the connection string and database password.
If your network has no IPv6, use the "Session pooler" string from the
**Connect** dialog. For local, make sure `supabase status` shows it running.

**Port 8787 is in use.**
Another controller is running (`seraph status`), or something else has the
port. Pick another with `seraph setup --web-port 8790`.

**Linked sessions can't be messaged.**
`!seraph link` is read-only. To control a session, exit Claude and run
`seraph resume`, which reopens the same conversation under seraph.
