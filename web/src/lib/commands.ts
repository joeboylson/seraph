import { db } from "./supabase"
import type { Command } from "./types"

const listeners = new Set<(message: string) => void>()

/** Called with a message whenever a command can't be sent. */
export function onCommandError(listener: (message: string) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Queue a command for a session's wrapper. Doesn't wait for it to run. */
export async function sendCommand(sessionId: string, kind: string, payload: Record<string, unknown> = {}) {
  // The local database sometimes stalls for a few seconds; retry before giving up.
  let message = ""
  for (const delay of [0, 500, 1500, 3000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    const { error } = await db.from("commands").insert({ session_id: sessionId, kind, payload })
    if (!error) return
    message = error.message
  }
  for (const l of listeners) l(`Couldn't send to Claude: ${message}`)
  throw new Error(message)
}

/** Ask a computer's controller to do something and wait for its answer. */
export async function askDaemon<T>(kind: string, payload: Record<string, unknown>, target: string, timeoutMs = 30000): Promise<T> {
  const { data, error } = await db.from("commands").insert({ kind, payload, target }).select("id").single()
  if (error) throw new Error(error.message)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400))
    const { data: row } = await db.from("commands").select("*").eq("id", data.id).single<Command>()
    if (row?.status === "done") return row.result as T
    if (row?.status === "failed") throw new Error(row.error ?? "command failed")
  }
  throw new Error(`${target} didn't answer. Run \`seraph start\` (or \`seraph doctor\`) on it.`)
}

// Names understood by the wrapper's `keys` command.
export type KeyName =
  | "Enter" | "Escape" | "Tab" | "ShiftTab" | "Up" | "Down" | "Left" | "Right"
  | "Backspace" | "CtrlC" | "CtrlD" | "CtrlO" | "CtrlR" | "CtrlT" | "CtrlL"

export const sendKeys = (sessionId: string, keys: (KeyName | string)[]) => sendCommand(sessionId, "keys", { keys })

function report(action: string, error: { message: string } | null) {
  if (!error) return
  for (const l of listeners) l(`Couldn't ${action}: ${error.message}`)
  throw new Error(error.message)
}

export async function renameSession(sessionId: string, name: string) {
  const { error } = await db.from("sessions").update({ name: name.trim() || null }).eq("id", sessionId)
  report("rename the session", error)
}

/** Pause a session: mark it, then stop its Claude. Resuming clears the mark. */
export async function pauseSession(sessionId: string) {
  const { error } = await db.from("sessions").update({ paused_at: new Date().toISOString() }).eq("id", sessionId)
  report("pause the session", error)
  await sendCommand(sessionId, "kill")
}

/** End a paused session for good: it moves to the ended ones. */
export async function endPaused(sessionId: string) {
  const { error } = await db.from("sessions").update({ paused_at: null }).eq("id", sessionId)
  report("end the session", error)
}

/** Delete an ended session with its transcript, events and commands. */
export async function deleteSession(sessionId: string) {
  const { error } = await db.from("sessions").delete().eq("id", sessionId).eq("status", "ended")
  report("delete the session", error)
}
