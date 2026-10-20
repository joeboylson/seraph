import { useCallback, useEffect, useState } from "react"

/** Sessions pinned as tabs at the top, at most this many. Kept in this browser. */
export const MAX_PINS = 5
const KEY = "seraph:pins"

function read(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]")
    return Array.isArray(value) ? value.filter((v) => typeof v === "string").slice(0, MAX_PINS) : []
  } catch {
    return []
  }
}

// Every component using pins hears about a change, as do other windows.
const listeners = new Set<(pins: string[]) => void>()

function save(pins: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(pins))
  } catch {
    // private browsing may refuse; pins then last until the page closes
  }
  for (const l of listeners) l(pins)
}

export function usePins() {
  const [pins, setPins] = useState(read)
  useEffect(() => {
    listeners.add(setPins)
    const onStorage = (e: StorageEvent) => e.key === KEY && setPins(read())
    window.addEventListener("storage", onStorage)
    return () => {
      listeners.delete(setPins)
      window.removeEventListener("storage", onStorage)
    }
  }, [])
  const toggle = useCallback((id: string) => {
    const now = read()
    if (now.includes(id)) save(now.filter((p) => p !== id))
    else if (now.length < MAX_PINS) save([...now, id])
  }, [])
  /** Drop pins for sessions that no longer exist. */
  const prune = useCallback((existing: Set<string>) => {
    const now = read()
    const kept = now.filter((p) => existing.has(p))
    if (kept.length !== now.length) save(kept)
  }, [])
  return { pins, toggle, prune }
}
