// Start this repo's local Supabase for the tests, apply its migrations, and
// write the tests' own seraph settings to e2e/.seraph/config.json.
// The tests never touch the Supabase in ~/.seraph: they read only that file.
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const repo = path.resolve(import.meta.dirname, "../..")
const home = path.resolve(import.meta.dirname, "../e2e/.seraph")
// Same as `seraph setup --local` (src/setup.rs): only what seraph uses.
const EXCLUDE = "storage-api,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor"
const NETWORK = "supabase_network_claude-supabase-controller"

function status() {
  const out = spawnSync("supabase", ["status", "-o", "env"], { cwd: repo, encoding: "utf8" })
  if (out.status !== 0) return null
  const env = Object.fromEntries(
    out.stdout.split("\n").filter((l) => l.includes("=")).map((l) => {
      const i = l.indexOf("=")
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]
    }),
  )
  const url = env.API_URL
  const key = env.PUBLISHABLE_KEY ?? env.ANON_KEY
  const secret = env.SECRET_KEY ?? env.SERVICE_ROLE_KEY
  return url && key && secret ? { url, key, secret } : null
}

let found = status()
if (!found) {
  // Created first so the stack's ports listen on 127.0.0.1 only.
  const inspect = spawnSync("docker", ["network", "inspect", NETWORK, "--format", '{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}'], { encoding: "utf8" })
  if (inspect.status !== 0 || inspect.stdout.trim() !== "127.0.0.1") {
    if (inspect.status === 0) spawnSync("docker", ["network", "rm", NETWORK])
    execFileSync("docker", ["network", "create", "-o", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", NETWORK], { stdio: "inherit" })
  }
  console.log("Starting the tests' local Supabase…")
  execFileSync("supabase", ["start", "-x", EXCLUDE], { cwd: repo, stdio: "inherit" })
  found = status()
  if (!found) throw new Error("local Supabase started, but `supabase status` didn't report its address")
}
execFileSync("supabase", ["migration", "up", "--local"], { cwd: repo, stdio: "inherit" })

fs.mkdirSync(home, { recursive: true })
fs.writeFileSync(
  path.join(home, "config.json"),
  // A port of its own, so the tests' controller can run beside the real one.
  JSON.stringify({ supabase_url: found.url, supabase_key: found.key, supabase_secret_key: found.secret, web_port: 8788 }, null, 2) + "\n",
)
console.log(`Tests use ${found.url}`)
