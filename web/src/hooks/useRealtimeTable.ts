import { useCallback, useEffect, useRef, useState } from "react"
import { db } from "@/lib/supabase"

type Options = {
  table: string
  filter?: { column: string; value: string }
  order?: string
  ascending?: boolean
  limit?: number
  enabled?: boolean
  /** How often to reload in case Realtime missed a change. */
  resyncMs?: number
}

/**
 * Load rows from a table and keep them current with Realtime.
 * Rows are matched on `key` for updates and deletes.
 */
export function useRealtimeTable<T extends Record<string, unknown>>(
  { table, filter, order = "id", ascending = true, limit = 2000, enabled = true, resyncMs = 30_000 }: Options,
  key: keyof T = "id",
) {
  const [rows, setRows] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const loadRef = useRef<() => void>(() => {})
  const filterValue = filter?.value
  const filterColumn = filter?.column

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setRows([])
    setLoading(true)

    const upsert = (row: T) =>
      setRows((prev) => {
        const i = prev.findIndex((r) => r[key] === row[key])
        if (i === -1) return [...prev, row]
        const next = prev.slice()
        next[i] = row
        return next
      })

    const filterString = filterColumn ? `${filterColumn}=eq.${filterValue}` : undefined
    const channel = db
      .channel(`${table}:${filterString ?? "all"}:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table, filter: filterString }, (change) => {
        if (change.eventType === "DELETE") {
          const old = change.old as T
          setRows((prev) => prev.filter((r) => r[key] !== old[key]))
        } else {
          upsert(change.new as T)
        }
      })
      // Load once we're listening, so no change slips in between; and
      // again after a reconnect, which may have missed some.
      .subscribe((status) => {
        if (status === "SUBSCRIBED") load()
      })

    function load() {
      let query = db.from(table).select("*").order(order, { ascending }).limit(limit)
      if (filterColumn) query = query.eq(filterColumn, filterValue)
      query.then(({ data }) => {
        if (cancelled || !data) return
        // Loaded rows win over older copies; rows only Realtime has seen stay.
        setRows((prev) => {
          const loaded = data as T[]
          const ids = new Set(loaded.map((r) => r[key]))
          return [...loaded, ...prev.filter((r) => !ids.has(r[key]))]
        })
        setLoading(false)
      })
    }

    loadRef.current = load
    // A phone pauses the page while it sleeps; catch up as soon as it's back.
    const onVisible = () => document.visibilityState === "visible" && load()
    document.addEventListener("visibilitychange", onVisible)

    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisible)
      db.removeChannel(channel)
    }
  }, [table, filterColumn, filterValue, order, ascending, limit, enabled, key])

  // Realtime can drop changes when the database is struggling, so resync
  // now and then too. Its own effect: a new pace mustn't reload from empty.
  useEffect(() => {
    if (!enabled) return
    const resync = setInterval(() => loadRef.current(), resyncMs)
    return () => clearInterval(resync)
  }, [enabled, resyncMs])

  const reload = useCallback(() => loadRef.current(), [])
  return { rows, loading, reload }
}
