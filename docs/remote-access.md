# The page

The page is a static site in `web/`, hosted on its own (Vercel here, at
https://seraph-omega-ten.vercel.app). It talks only to Supabase, and the
controller on each computer talks only to Supabase, so the host never needs
to reach your computers. Every device signs in once with your email.

## Deploying it

On [Vercel](https://vercel.com), with the CLI logged in (`vercel login`):

```sh
cd web
vercel deploy --prod
```

The project needs three settings (Vercel → Settings → Environment
Variables), since they're built into the page:

| Setting | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | Your project's URL |
| `VITE_SUPABASE_KEY` | The publishable key (never the secret one) |
| `VITE_VAPID_PUBLIC_KEY` | The "Push key" line from `seraph status`, for notifications |

In Supabase, set **Authentication → URL Configuration** so the sign-in
email's link comes back to the page: Site URL = the page's address, and the
same address under Redirect URLs. Then tell seraph where the page is, for
`seraph open`:

```sh
seraph setup --page-url https://<your page>
```

Any static host works the same way: build with `npx vite build` and those
three settings, and serve `web/dist`.

Anyone can open the page's address, but only members can sign in, and the
data is locked to members; see [security](security.md). Whoever signs in can
run commands on your computers through Claude, so only add accounts you trust.

## Installing on your other computers

With [Tailscale](https://tailscale.com), one computer can hand seraph to the
others:

```sh
seraph tailscale
```

prints the line to run on each other computer of the same kind
(`curl -fsSL https://<machine>.<tailnet>.ts.net:8446/install | sh`), which
installs or updates seraph from this one. Undo with `seraph tailscale --off`.
