// Run a command with a seraph controller of its own, connected to the tests'
// local Supabase (e2e/.seraph), and stop the controller afterwards.
// Usage: node scripts/with-controller.mjs <command> [args…]
import { spawn, spawnSync } from "node:child_process"
import path from "node:path"

const home = path.resolve(import.meta.dirname, "../e2e/.seraph")
const env = { ...process.env, SERAPH_HOME: home }
const controller = spawn("seraph", ["daemon"], { env, stdio: ["ignore", "inherit", "inherit"] })
const stop = () => controller.kill("SIGTERM")
process.on("SIGINT", () => (stop(), process.exit(130)))

// Give it a moment to check in before the tests look for it.
await new Promise((r) => setTimeout(r, 3000))
const [cmd, ...args] = process.argv.slice(2)
const run = spawnSync(cmd, args, { env, stdio: "inherit" })
stop()
process.exit(run.status ?? 1)
