# Development

## Layout

```
install.sh         builds the page and the binary, installs to ~/.local/bin
build.rs           stamps the build time into `seraph --version`
src/               the CLI (Rust)
  main.rs          commands and help
  config.rs        settings and paths
  supa.rs          Supabase REST
  wrapper.rs       seraph claude
  transcript.rs    transcript → messages
  hook.rs          seraph _hook, the hook Claude runs for every event
  daemon.rs        the controller, the page's web server, and /install
  embedded.rs      the page and Supabase files built into the binary
  push.rs          Web Push to phones
  link.rs          seraph link
  setup.rs         setup, db push, doctor
  service.rs       start/stop, start at login
  users.rs         seraph user
supabase/          local project and migrations
web/               the page (Vite, React, shadcn, Tailwind)
```

## The CLI

```sh
./install.sh            # page, then binary (the page is built into it), then install + restart
cargo test              # unit tests; `cargo test -- --ignored` also needs a Supabase
```

The page in `web/dist` and the files the Supabase CLI needs (`config.toml`,
migrations, templates) are built into the binary. Sessions already running
keep the binary they started with.

## The page

```sh
cd web
npm install
npx vite build      # needs VITE_SUPABASE_URL and VITE_SUPABASE_KEY; deploy with `vercel deploy --prod`
```

For hot reload, `npx vite` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_KEY`
set (there's no controller to ask in dev mode).

## Tests

Playwright, run against the page the controller serves, using the
settings in `~/.seraph/config.json`:

```sh
cd web
npm test            # UI tests: the test plays the wrapper's side, no Claude needed (~20s)
npm run test:real   # a real Claude (Haiku) builds a small app entirely through
                    # the page; needs `seraph start`; costs a few cents (~1–3 min)
```

`web/scripts/screen.mjs <session id>` prints a session's current screen,
which is handy for seeing what Claude is showing.

## Schema changes

Add a file to `supabase/migrations/`, then `seraph db push`. Add any new
tables to `supabase/uninstall.sql`.
