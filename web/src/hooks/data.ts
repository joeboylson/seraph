import { useCallback, useEffect, useMemo, useState } from "react"
import { db } from "@/lib/supabase"
import type { Command, Controller, HookEvent, LogLine, MessageRow, Session } from "@/lib/types"
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

/** A controller checks in every 10 minutes; seen within the hour (and not stopped) is active. */
export const ACTIVE_MS = 60 * 60 * 1000

export type Device = Controller & { active: boolean }

/** Every computer that has run seraph, active ones first, then by name. */
export function useDevices(): Device[] {
  const { rows } = useRealtimeTable<Controller>({ table: "controllers", order: "last_seen" }, "id")
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  return useMemo(
    () =>
      rows
        .map((c) => ({ ...c, active: !c.stopped_at && now - new Date(c.last_seen).getTime() < ACTIVE_MS }))
        .sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id)),
    [rows, now],
  )
}

/** The active computers: the ones the page can start and resume sessions on. */
export function useMachines(): Device[] {
  const devices = useDevices()
  return useMemo(() => devices.filter((d) => d.active), [devices])
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

/** Each session's newest reply from Claude, for the overview. Rechecked every 10 seconds. */
export function useLastReplies(sessionIds: string[]) {
  const key = sessionIds.slice().sort().join(",")
  const [replies, setReplies] = useState<Record<string, MessageRow>>({})
  useEffect(() => {
    if (!key) return setReplies({})
    let gone = false
    const load = async () => {
      const { data } = await db
        .from("messages")
        .select("*")
        .in("session_id", key.split(","))
        .eq("type", "assistant")
        .order("id", { ascending: false })
        .limit(400)
      if (gone || !data) return
      const latest: Record<string, MessageRow> = {}
      for (const m of data as MessageRow[]) {
        const content = m.data.message?.content
        const hasText = Array.isArray(content) && content.some((b) => b.type === "text" && b.text.trim())
        if (hasText && !latest[m.session_id]) latest[m.session_id] = m
      }
      setReplies(latest)
    }
    load()
    const t = setInterval(load, 10_000)
    return () => {
      gone = true
      clearInterval(t)
    }
  }, [key])
  return replies
}

/** "0.2.5 (built …)" or "v0.2.5" to [0, 2, 5]. */
export function versionParts(v: string | null | undefined) {
  return (v ?? "").replace(/^v/, "").split(" ")[0].split(".").map((n) => Number(n) || 0)
}

/** Whether version `a` is older than `b`. */
export function olderThan(a: string | null | undefined, b: string | null | undefined) {
  const [x, y] = [versionParts(a), versionParts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

const RELEASE_KEY = "seraph:latest-release"

/** The newest published seraph release ("v0.2.6"), from GitHub, checked at most every 10 minutes. */
export function useLatestRelease() {
  const [tag, setTag] = useState<string | null>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(RELEASE_KEY) ?? "null")
      return saved && Date.now() - saved.at < 600_000 ? saved.tag : null
    } catch {
      return null
    }
  })
  useEffect(() => {
    if (tag) return
    fetch("https://api.github.com/repos/joeboylson/seraph/releases/latest")
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => {
        if (!r?.tag_name) return
        setTag(r.tag_name)
        try {
          sessionStorage.setItem(RELEASE_KEY, JSON.stringify({ tag: r.tag_name, at: Date.now() }))
        } catch {
          // only for this view then
        }
      })
      .catch(() => {})
  }, [tag])
  return tag
}

/** A computer's newest log lines (see logship.rs), newest first. */
export function useDeviceLogs(machine: string) {
  const [lines, setLines] = useState<LogLine[] | null>(null)
  const load = useCallback(async () => {
    const { data } = await db.from("logs").select("*").eq("machine", machine).order("id", { ascending: false }).limit(150)
    setLines((data as LogLine[] | null) ?? [])
  }, [machine])
  useEffect(() => {
    load()
  }, [load])
  return { lines, reload: load }
}
