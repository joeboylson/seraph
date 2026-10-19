import { createClient } from "@supabase/supabase-js"
import { expect, type Page } from "@playwright/test"

import { testSettings } from "./settings"

const { url: SUPABASE_URL, secretKey: SECRET_KEY } = testSettings()

/** Plays seraph's part, so it uses the secret key and skips the members-only rules. */
export const db = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

/** A session row with no real Claude behind it. The test plays the wrapper. */
export async function fakeSession(overrides: Record<string, unknown> = {}) {
  const { data, error } = await db
    .from("sessions")
    .insert({ cwd: "/tmp/seraph-test/project", name: `test ${Date.now()}`, mode: "headless", status: "idle", cols: 100, rows: 30, model: "haiku", permission_mode: "default", ...overrides })
    .select()
    .single()
  if (error) throw error
  return data as { id: string; name: string }
}

export async function addMessages(sessionId: string, entries: Record<string, unknown>[]) {
  const rows = entries.map((data, i) => ({ session_id: sessionId, uuid: `m${Date.now()}-${i}`, type: data.type as string, data }))
  const { error } = await db.from("messages").insert(rows)
  if (error) throw error
}

export async function removeSession(id: string) {
  await db.from("sessions").delete().eq("id", id)
}

/** Send terminal output the way the wrapper does. */
let seq = 0

export async function sendScreen(sessionId: string, text: string, chunkSeq = ++seq) {
  seq = chunkSeq
  const data = Buffer.from(text.replace(/\n/g, "\r\n")).toString("base64")
  // The local gateway sometimes answers 502 under load; retry like the wrapper does.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: SECRET_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ topic: `term:${sessionId}`, event: "out", private: true, payload: { seq: chunkSeq, data } }] }),
    })
    if (res.ok) return
    if (attempt === 4) throw new Error(`broadcast failed: ${res.status}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** Wait for the page to queue a command, and return it. */
export async function expectCommand(sessionId: string, kind: string, match: (payload: Record<string, unknown>) => boolean = () => true) {
  let found: { id: number; payload: Record<string, unknown> } | undefined
  await expect
    .poll(async () => {
      const { data } = await db.from("commands").select("id,payload").eq("session_id", sessionId).eq("kind", kind).order("id")
      found = (data ?? []).find((c) => match(c.payload))
      return Boolean(found)
    }, { timeout: 20_000 })
    .toBe(true)
  return found!
}

/** The account the tests sign in as. The setup step creates it; teardown deletes it. */
export const TEST_EMAIL = "seraph-e2e@test.invalid"

/** Make an account that can be sent codes, on the members list or not. Returns its id. */
export async function createAccount(email: string, member = true) {
  const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 })
  const user = list?.users.find((u) => u.email === email) ?? (await db.auth.admin.createUser({ email, email_confirm: true })).data.user
  if (!user) throw new Error(`couldn't create ${email}`)
  if (member) await db.from("members").upsert({ user_id: user.id })
  else await db.from("members").delete().eq("user_id", user.id)
  return user.id
}

export async function deleteAccount(email: string) {
  const { data } = await db.auth.admin.listUsers({ perPage: 1000 })
  const user = data?.users.find((u) => u.email === email)
  if (user) await db.auth.admin.deleteUser(user.id)
}

/** A fresh sign-in code for `email`, made with the secret key instead of read from an email. */
export async function signInCode(email: string) {
  const { data, error } = await db.auth.admin.generateLink({ type: "magiclink", email })
  if (error) throw error
  return data.properties.email_otp
}

/**
 * Ask the login screen for a code. The email itself is skipped: the tests'
 * addresses don't exist, and on a hosted project bounced emails can get its
 * email sending restricted. The code comes from `signInCode` instead.
 */
export async function requestCode(page: Page, email: string) {
  await page.route("**/auth/v1/otp*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }))
  await page.getByTestId("login-email").fill(email)
  await expect(async () => {
    await page.getByRole("button", { name: "Send code" }).click()
    await expect(page.getByTestId("login-code")).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 20_000 })
}
