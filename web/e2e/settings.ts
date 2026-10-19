import fs from "node:fs"
import path from "node:path"

/** The tests' own seraph folder, written by scripts/test-supabase.mjs. */
export const TEST_HOME = path.resolve(import.meta.dirname, ".seraph")

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/**
 * The local Supabase the tests use. Never the one in ~/.seraph: tests add and
 * delete sessions and accounts, so they refuse anything that isn't local.
 */
export function testSettings() {
  let saved: Record<string, string> = {}
  try {
    saved = JSON.parse(fs.readFileSync(path.join(TEST_HOME, "config.json"), "utf8"))
  } catch {
    throw new Error("The tests' local Supabase isn't set up. Run `npm test` (or `node scripts/test-supabase.mjs`) from web/.")
  }
  const { supabase_url: url, supabase_key: key, supabase_secret_key: secretKey } = saved
  if (!url || !key || !secretKey) throw new Error(`${TEST_HOME}/config.json is missing settings; run node scripts/test-supabase.mjs`)
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error(`Tests only run against a local Supabase, not ${url}`)
  return { url, key, secretKey }
}
