import { useEffect, useMemo, useState } from "react"
import { db } from "@/lib/supabase"
import type { Command, Controller, HookEvent, MessageRow, Session } from "@/lib/types"
import { useRealtimeTable } from "./useRealtimeTable"

export function useSessions() {
  const { rows, loading, reload } = useRealtimeTable<Session>({ table: "sessions", order: "created_at", ascending: false }, "id")
  const sessions = useMemo(
    () => rows.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [rows],
  )
  return { sessions, loading, reload }
}

export function useMessages(sessionId: string, working = false) {
  // Newest first, so a long session loads its latest messages. While Claude
  // works, check often, so the chat never trails the terminal for long.
  const { rows, loading } = useRealtimeTable<MessageRow>({
    table: "messages",
    filter: { column: "session_id", value: sessionId },
    ascending: false,
    resyncMs: working ? 5_000 : 30_000,
  })
  const messages = useMemo(() => rows.slice().sort((a, b) => a.id - b.id), [rows])
  return { messages, loading }
}

export function useSessionEvents(sessionId: string) {
  const { rows } = useRealtimeTable<HookEvent>({
    table: "events",
    filter: { column: "csc_session", value: sessionId },
    ascending: false,
    limit: 200,
  })
  return useMemo(() => rows.slice().sort((a, b) => a.id - b.id), [rows])
}

/** The daemon checks in every 10s; allow for a slow database before calling it offline. */
/** The computers whose controller has checked in lately, by name. */
export function useMachines() {
  const { rows } = useRealtimeTable<Controller>({ table: "controllers", order: "last_seen" }, "id")
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  return useMemo(() => rows.filter((c) => now - new Date(c.last_seen).getTime() < 90_000).sort((a, b) => a.id.localeCompare(b.id)), [rows, now])
}

/** False while this page has lost its live connection to Supabase. */
export function useConnected() {
  const check = () => navigator.onLine && db.realtime.isConnected()
  const [connected, setConnected] = useState(true)
  useEffect(() => {
    // Give the first connection a moment before calling it lost.
    const first = setTimeout(() => setConnected(check()), 5000)
    const t = setInterval(() => setConnected(check()), 2000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [])
  return connected
}

/** Messages and slash commands sent from the page, newest 50. */
export function useSentPrompts(sessionId: string) {
  const { rows } = useRealtimeTable<Command & { created_at: string }>({
    table: "commands",
    filter: { column: "session_id", value: sessionId },
    ascending: false,
    limit: 200,
  })
  return useMemo(() => rows.filter((c) => c.kind === "prompt").sort((a, b) => a.id - b.id).slice(-50), [rows])
}
