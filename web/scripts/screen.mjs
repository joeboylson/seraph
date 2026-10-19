// Print a session's current screen: node scripts/screen.mjs <session-id> [wait-ms]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import xtermHeadless from "@xterm/headless"
import { createClient } from "@supabase/supabase-js"

const [sessionId, waitMs = "6000"] = process.argv.slice(2)
const saved = JSON.parse(fs.readFileSync(path.join(process.env.SERAPH_HOME ?? path.join(os.homedir(), ".seraph"), "config.json"), "utf8"))
// The secret key: the data is members-only, and this plays seraph's part.
const db = createClient(process.env.SERAPH_SUPABASE_URL ?? saved.supabase_url, process.env.SERAPH_SUPABASE_SECRET_KEY ?? saved.supabase_secret_key, { auth: { persistSession: false } })
const { data: session } = await db.from("sessions").select("cols,rows").eq("id", sessionId).single()
const term = new xtermHeadless.Terminal({ cols: session?.cols ?? 120, rows: session?.rows ?? 40, allowProposedApi: true })

const channel = db.channel(`term:${sessionId}`, { config: { private: true } })
channel.on("broadcast", { event: "reset" }, ({ payload }) => { term.reset(); term.resize(payload.cols, payload.rows) })
channel.on("broadcast", { event: "out" }, ({ payload }) => term.write(Buffer.from(payload.data, "base64")))
await new Promise((resolve) => channel.subscribe((s) => s === "SUBSCRIBED" && resolve()))
await db.from("commands").insert({ session_id: sessionId, kind: "replay" })
await new Promise((r) => setTimeout(r, Number(waitMs)))
await new Promise((r) => term.write("", r))
const buf = term.buffer.active
const lines = []
for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "")
while (lines.length && !lines.at(-1).trim()) lines.pop()
console.log(lines.slice(-term.rows).join("\n"))
process.exit(0)
