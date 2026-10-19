import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** The same settings seraph uses: SERAPH_* environment variables, then ~/.seraph/config.json. */
export function seraphSettings() {
  const home = process.env.SERAPH_HOME ?? path.join(os.homedir(), ".seraph")
  let saved: Record<string, unknown> = {}
  try {
    saved = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"))
  } catch {
    // fall back to the environment only
  }
  const url = process.env.SERAPH_SUPABASE_URL ?? (saved.supabase_url as string | undefined)
  const key = process.env.SERAPH_SUPABASE_KEY ?? (saved.supabase_key as string | undefined)
  const secretKey = process.env.SERAPH_SUPABASE_SECRET_KEY ?? (saved.supabase_secret_key as string | undefined)
  if (!url || !key || !secretKey) throw new Error("seraph isn't set up; run `seraph setup` first")
  const port = Number(process.env.SERAPH_WEB_PORT ?? saved.web_port ?? 8787)
  return { url, key, secretKey, webUrl: `http://127.0.0.1:${port}` }
}
