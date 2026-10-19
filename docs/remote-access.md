# Reaching the page from your phone

The controller serves the page on `http://127.0.0.1:8787`, which only this
machine can open. To use it from another device, the page and Supabase both
need to be reachable from there.

## Tailscale (recommended)

With [Tailscale](https://tailscale.com) on this machine and your phone:

```sh
seraph tailscale
```

This serves the page at `https://<machine>.<tailnet>.ts.net:8446`, private
to your tailnet, with HTTPS (which browser notifications need). If you use
a local Supabase, seraph also serves it on port 8447 and tells the page to use
that address when it's opened from another device. A hosted Supabase needs
no extra step.

Pick other ports with `--web-port` and `--api-port`. Undo with
`seraph tailscale --off`.

## Other options

Any way of reaching port 8787 works: an SSH tunnel
(`ssh -L 8787:127.0.0.1:8787 your-mac`), a VPN, or a reverse proxy you
already run. If Supabase is local, the page also needs to reach it. Set
`seraph setup --browser-url <address the other device can use>`.

Each device signs in once with a code sent to your email (see
[Security](../README.md#security)). The data is locked to signed-in members,
but keep the page private anyway: whoever signs in can run commands on your
machine through Claude.

## Hosting the page somewhere else (e.g. Vercel)

The page is a static site in `web/dist`, so any static host can serve it.
It needs a hosted Supabase project (the browser has to reach it), and
three build settings, since there's no controller to ask:

| Setting | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | Your project's URL |
| `VITE_SUPABASE_KEY` | The publishable key (never the secret one) |
| `VITE_VAPID_PUBLIC_KEY` | The "Push key" line from `seraph status`, for notifications |

The controller still runs on your computer (`seraph start`) to start sessions.
It only talks to Supabase, so the host never needs to reach your computer.
Anyone can open the page's address, but only members can sign in; see
[security](security.md).
