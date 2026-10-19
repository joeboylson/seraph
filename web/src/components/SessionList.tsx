import { PlusIcon, SearchIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn, timeAgo } from "@/lib/utils"
import type { Session } from "@/lib/types"
import { StatusBadge } from "./StatusBadge"

export function sessionTitle(s: Session) {
  return s.name || s.cwd.split("/").filter(Boolean).pop() || s.cwd
}

function shortPath(path: string, home?: string) {
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path
}

export function SessionList({
  sessions,
  selectedId,
  homes,
  onSelect,
  onNew,
}: {
  sessions: Session[]
  selectedId: string | null
  /** Each online computer's home folder, by name. */
  homes: Record<string, string>
  onSelect: (id: string) => void
  onNew: () => void
}) {
  const [query, setQuery] = useState("")
  // With sessions on several computers, say which one each is on.
  const manyMachines = new Set(sessions.map((s) => s.hostname)).size > 1
  const [shown, setShown] = useState(20)
  const q = query.trim().toLowerCase()
  const matching = q ? sessions.filter((s) => `${s.name ?? ""} ${s.cwd}`.toLowerCase().includes(q)) : sessions
  const live = matching.filter((s) => s.status !== "ended")
  const allEnded = matching.filter((s) => s.status === "ended")
  const ended = allEnded.slice(0, shown)
  // Running sessions on several computers are grouped under each one, online
  // computers first. With one computer the list looks as it always has.
  const groups = [...new Set(live.map((s) => s.hostname ?? "Unknown computer"))].sort(
    (a, b) => Number(b in homes) - Number(a in homes) || a.localeCompare(b),
  )

  const item = (s: Session) => (
    <li key={s.id}>
      <button
        type="button"
        onClick={() => onSelect(s.id)}
        aria-current={s.id === selectedId}
        data-testid="session-item"
        className={cn(
          "w-full border-l-2 border-transparent py-s3 pr-s4 pl-s4 text-left transition-colors duration-[144ms] ease-slag",
          "text-muted-foreground hover:text-foreground",
          s.id === selectedId && "border-highlight text-foreground",
        )}
      >
        <span className="flex items-center justify-between gap-s3">
          <span className="truncate text-sm font-medium">{sessionTitle(s)}</span>
          {s.status === "ended" ? (
            <span className="label shrink-0 normal-case">{timeAgo(s.ended_at ?? s.updated_at)}</span>
          ) : (
            <StatusBadge status={s.status} className="shrink-0" />
          )}
        </span>
        {/* Right-to-left so a long path loses its start, not the folder name. */}
        <span className="block truncate font-mono text-xs [direction:rtl]" title={s.cwd}>
          <bdi>{shortPath(s.cwd, s.hostname ? homes[s.hostname] : undefined)}</bdi>
        </span>
        {manyMachines && s.status === "ended" && s.hostname && <span className="label block truncate normal-case" data-testid="session-machine">{s.hostname}</span>}
      </button>
    </li>
  )

  return (
    <nav aria-label="Sessions" className="flex flex-col gap-s5">
      <Button onClick={onNew} className="w-full rounded-full" data-testid="new-session">
        <PlusIcon /> New session
      </Button>
      {sessions.length > 8 && (
        <label className="relative mx-s4 block">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-s3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a session" aria-label="Find a session" className="pl-s6" data-testid="session-search" />
        </label>
      )}
      <section>
        <p className="label px-s4 pb-s3">Running</p>
        {groups.length > 1 ? (
          groups.map((machine) => (
            <div key={machine} className="pb-s3" data-testid="machine-group">
              <p className="flex items-center gap-s2 px-s4 pb-s1 text-sm font-medium" title={machine in homes ? "Online" : "Offline"}>
                <span className={cn("size-2 shrink-0 rounded-full", machine in homes ? "bg-success" : "bg-muted-foreground/50")} aria-hidden />
                <span className="truncate">{machine}</span>
              </p>
              <ul>{live.filter((s) => (s.hostname ?? "Unknown computer") === machine).map(item)}</ul>
            </div>
          ))
        ) : live.length ? (
          <ul>{live.map(item)}</ul>
        ) : (
          <p className="px-s4 text-sm text-muted-foreground">
            {q ? "No running session matches." : <>Nothing running. Start a session, or run <code className="font-mono">seraph claude</code> in a terminal.</>}
          </p>
        )}
      </section>
      {ended.length > 0 && (
        <section>
          <p className="label px-s4 pb-s3">Ended</p>
          <ul>{ended.map(item)}</ul>
          {allEnded.length > shown && (
            <Button variant="ghost" size="sm" className="mt-s2 ml-s2 rounded-full" onClick={() => setShown((n) => n + 30)}>
              Show more ({allEnded.length - shown})
            </Button>
          )}
        </section>
      )}
    </nav>
  )
}
