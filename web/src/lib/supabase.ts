import { createClient, type SupabaseClient } from "@supabase/supabase-js"

export type BrowserSettings = { supabaseUrl: string; supabaseKey: string; vapidPublicKey?: string | null }

/** Set by `connect()` before the app renders. */
export let db: SupabaseClient
export let settings: BrowserSettings

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/

/**
 * Ask `seraph daemon` (which serves this page) how to reach Supabase. In
 * `vite dev` there's no daemon, so VITE_SUPABASE_URL/KEY are used instead.
 */
export async function connect(): Promise<BrowserSettings> {
  let loaded: BrowserSettings | null = null
  try {
    const res = await fetch("/config.json", { cache: "no-store" })
    if (res.ok) loaded = await res.json()
  } catch {
    // fall through to the build-time settings
  }
  loaded ??= import.meta.env.VITE_SUPABASE_URL
    ? {
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
        supabaseKey: import.meta.env.VITE_SUPABASE_KEY,
        vapidPublicKey: import.meta.env.VITE_VAPID_PUBLIC_KEY,
      }
    : null
  if (!loaded) throw new Error("Couldn't load settings from the controller. Run `seraph start` on your computer.")

  // A local Supabase at 127.0.0.1 is only reachable from this machine.
  const supabaseHost = new URL(loaded.supabaseUrl).hostname
  if (LOOPBACK.test(supabaseHost) && !LOOPBACK.test(location.hostname)) {
    throw new Error(
      `Supabase is at ${loaded.supabaseUrl}, which only works on the machine running seraph. ` +
        "Run `seraph tailscale` there to make it reachable from this device.",
    )
  }
  db = createClient(loaded.supabaseUrl, loaded.supabaseKey)
  settings = loaded
  return loaded
}
