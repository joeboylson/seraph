// Run a command with a seraph controller of its own (built from this repo), connected to the tests'
// local Supabase (e2e/.seraph), and stop the controller afterwards.
// Usage: node scripts/with-controller.mjs <command> [args…]
import { spawn, spawnSync } from "node:child_process"
import path from "node:path"

const home = path.resolve(import.meta.dirname, "../e2e/.seraph")
const env = { ...process.env, SERAPH_HOME: home }
// This repo's own seraph, built fresh, so the tests check the code here.
const repo = path.resolve(import.meta.dirname, "../..")
const built = spawnSync("cargo", ["build", "--quiet"], { cwd: repo, stdio: "inherit" })
if (built.status !== 0) process.exit(built.status ?? 1)
const seraph = path.join(repo, "target/debug/seraph")
const controller = spawn(seraph, ["daemon"], { env, stdio: ["ignore", "inherit", "inherit"] })
const stop = () => controller.kill("SIGTERM")
process.on("SIGINT", () => (stop(), process.exit(130)))

// Give it a moment to check in before the tests look for it.
await new Promise((r) => setTimeout(r, 3000))
const [cmd, ...args] = process.argv.slice(2)
const run = spawnSync(cmd, args, { env, stdio: "inherit" })
stop()
process.exit(run.status ?? 1)
