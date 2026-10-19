import { createClient, type SupabaseClient } from "@supabase/supabase-js"

export type BrowserSettings = { supabaseUrl: string; supabaseKey: string; vapidPublicKey?: string | null }

/** Set by `connect()` before the app renders. */
export let db: SupabaseClient
export let settings: BrowserSettings

/**
 * Connect with the settings built into the page: VITE_SUPABASE_URL,
 * VITE_SUPABASE_KEY and VITE_VAPID_PUBLIC_KEY, set where it's built (Vercel's
 * project settings, or the tests' own build).
 */
export async function connect(): Promise<BrowserSettings> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const supabaseKey = import.meta.env.VITE_SUPABASE_KEY
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("This build of the page has no Supabase settings. Set VITE_SUPABASE_URL and VITE_SUPABASE_KEY where it's built.")
  }
  settings = { supabaseUrl, supabaseKey, vapidPublicKey: import.meta.env.VITE_VAPID_PUBLIC_KEY }
  db = createClient(supabaseUrl, supabaseKey)
  return settings
}
