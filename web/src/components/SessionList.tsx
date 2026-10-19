import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, SearchIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn, timeAgo } from "@/lib/utils"
import type { Session } from "@/lib/types"
import { StatusBadge } from "./StatusBadge"

export function sessionTitle(s: Session) {
  return s.name || s.cwd.split("/").filter(Boolean).pop() || s.cwd
}

const UNKNOWN = "Unknown computer"
const deviceOf = (s: Session) => s.hostname ?? UNKNOWN

function OnlineDot({ online }: { online: boolean }) {
  return <span className={cn("size-2 shrink-0 rounded-full", online ? "bg-success" : "bg-muted-foreground/50")} title={online ? "Online" : "Offline"} aria-hidden />
}

export function SessionList({
  sessions,
  selectedId,
  online,
  onSelect,
  onNew,
}: {
  sessions: Session[]
  selectedId: string | null
  /** The computers whose controller is running right now. */
  online: string[]
  onSelect: (id: string) => void
  onNew: () => void
}) {
  // undefined: follow the open session's device. null: the device list.
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  const selected = sessions.find((s) => s.id === selectedId)
  const device = picked === undefined ? (selected ? deviceOf(selected) : null) : picked

  const devices = [...new Set([...online, ...sessions.map(deviceOf)])].sort(
    (a, b) => Number(online.includes(b)) - Number(online.includes(a)) || a.localeCompare(b),
  )

  return (
    <nav aria-label="Sessions" className="flex flex-col gap-s5">
      <Button onClick={onNew} className="w-full rounded-full" data-testid="new-session">
        <PlusIcon /> New session
      </Button>
      {device === null ? (
        <section>
          <p className="label px-s4 pb-s3">Devices</p>
          {devices.length ? (
            <ul>
              {devices.map((d) => {
                const running = sessions.filter((s) => deviceOf(s) === d && s.status !== "ended").length
                return (
                  <li key={d}>
                    <button
                      type="button"
                      onClick={() => setPicked(d)}
                      data-testid="device-item"
                      className="flex w-full items-center gap-s3 py-s3 pr-s4 pl-s4 text-left text-muted-foreground transition-colors duration-[144ms] ease-slag hover:text-foreground"
                    >
                      <OnlineDot online={online.includes(d)} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{d}</span>
                      {running > 0 && <span className="label shrink-0 normal-case">{running} running</span>}
                      <ChevronRightIcon className="size-4 shrink-0" />
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="px-s4 text-sm text-muted-foreground">No devices yet. Run the controller on a computer to see it here.</p>
          )}
        </section>
      ) : (
        <DeviceSessions
          key={device}
          device={device}
          online={online.includes(device)}
          sessions={sessions.filter((s) => deviceOf(s) === device)}
          selectedId={selectedId}
          onSelect={onSelect}
          onBack={() => setPicked(null)}
        />
      )}
    </nav>
  )
}

function DeviceSessions({
  device,
  online,
  sessions,
  selectedId,
  onSelect,
  onBack,
}: {
  device: string
  online: boolean
  sessions: Session[]
  selectedId: string | null
  onSelect: (id: string) => void
  onBack: () => void
}) {
  const [query, setQuery] = useState("")
  const [shown, setShown] = useState(20)
  // Ended sessions stay folded away unless asked for, searched, or open.
  const [endedOpen, setEndedOpen] = useState(() => sessions.some((s) => s.id === selectedId && s.status === "ended"))
  const q = query.trim().toLowerCase()
  const matching = q ? sessions.filter((s) => sessionTitle(s).toLowerCase().includes(q)) : sessions
  const live = matching.filter((s) => s.status !== "ended")
  const allEnded = matching.filter((s) => s.status === "ended")
  const ended = allEnded.slice(0, shown)

  const item = (s: Session) => (
    <li key={s.id}>
      <button
        type="button"
        onClick={() => onSelect(s.id)}
        aria-current={s.id === selectedId}
        data-testid="session-item"
        className={cn(
          "flex w-full items-center justify-between gap-s3 border-l-2 border-transparent py-s3 pr-s4 pl-s4 text-left transition-colors duration-[144ms] ease-slag",
          "text-muted-foreground hover:text-foreground",
          s.id === selectedId && "border-highlight text-foreground",
        )}
      >
        <span className="truncate text-sm font-medium">{sessionTitle(s)}</span>
        {s.status === "ended" ? (
          <span className="label shrink-0 normal-case">{timeAgo(s.ended_at ?? s.updated_at)}</span>
        ) : (
          <StatusBadge status={s.status} className="shrink-0" />
        )}
      </button>
    </li>
  )

  return (
    <>
      <div className="flex flex-col gap-s2">
        <Button variant="ghost" size="sm" className="w-fit rounded-full text-muted-foreground" onClick={onBack} data-testid="devices-back">
          <ChevronLeftIcon /> Devices
        </Button>
        <p className="flex items-center gap-s2 px-s4 text-sm font-medium" data-testid="device-name">
          <OnlineDot online={online} />
          <span className="truncate">{device}</span>
        </p>
      </div>
      {sessions.length > 8 && (
        <label className="relative mx-s4 block">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-s3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a session" aria-label="Find a session" className="pl-s6" data-testid="session-search" />
        </label>
      )}
      <section>
        <p className="label px-s4 pb-s3">Running</p>
        {live.length ? (
          <ul>{live.map(item)}</ul>
        ) : (
          <p className="px-s4 text-sm text-muted-foreground">
            {q ? "No running session matches." : <>Nothing running. Start a session, or run <code className="font-mono">seraph claude</code> in a terminal.</>}
          </p>
        )}
      </section>
      {ended.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setEndedOpen((o) => !o)}
            aria-expanded={endedOpen || !!q}
            className="label flex items-center gap-s2 px-s4 pb-s3 hover:text-foreground"
            data-testid="ended-toggle"
          >
            <ChevronDownIcon className={cn("size-4 transition-transform duration-[144ms] ease-slag", !(endedOpen || q) && "-rotate-90")} />
            Ended ({allEnded.length})
          </button>
          {(endedOpen || q) && (
            <>
              <ul>{ended.map(item)}</ul>
              {allEnded.length > shown && (
                <Button variant="ghost" size="sm" className="mt-s2 ml-s2 rounded-full" onClick={() => setShown((n) => n + 30)}>
                  Show more ({allEnded.length - shown})
                </Button>
              )}
            </>
          )}
        </section>
      )}
    </>
  )
}
