import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { cn, timeAgo } from "@/lib/utils"
import type { Session } from "@/lib/types"
import { StatusBadge, shownStatus } from "./StatusBadge"

export function sessionTitle(s: Session) {
  return s.name || s.cwd.split("/").filter(Boolean).pop() || s.cwd
}

/** When it started, to tell apart sessions that would otherwise look the same. */
const startedAt = (s: Session) => new Date(s.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

/** Titles that clash among `sessions` (e.g. two unnamed ones in one folder). */
export function clashingTitles(sessions: Session[]) {
  const seen = new Map<string, number>()
  for (const s of sessions) seen.set(sessionTitle(s), (seen.get(sessionTitle(s)) ?? 0) + 1)
  return (s: Session) => ((seen.get(sessionTitle(s)) ?? 0) > 1 ? startedAt(s) : null)
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
  const { setOpenMobile } = useSidebar()
  // undefined: follow the open session's device. null: the device list.
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  const selected = sessions.find((s) => s.id === selectedId)
  const device = picked === undefined ? (selected ? deviceOf(selected) : null) : picked

  const devices = [...new Set([...online, ...sessions.map(deviceOf)])].sort(
    (a, b) => Number(online.includes(b)) - Number(online.includes(a)) || a.localeCompare(b),
  )

  return (
    <Sidebar>
      <nav aria-label="Sessions" className="flex min-h-0 flex-1 flex-col">
        <SidebarHeader className="p-s4">
          <Button
            onClick={() => {
              onNew()
              setOpenMobile(false)
            }}
            className="w-full rounded-full"
            data-testid="new-session"
          >
            <PlusIcon /> New session
          </Button>
        </SidebarHeader>
        <SidebarContent>
          {device === null ? (
            <SidebarGroup>
              <SidebarGroupLabel className="label">Devices</SidebarGroupLabel>
              <SidebarGroupContent>
                {devices.length ? (
                  <SidebarMenu>
                    {devices.map((d) => {
                      const running = sessions.filter((s) => deviceOf(s) === d && s.status !== "ended" && !s.paused_at).length
                      return (
                        <SidebarMenuItem key={d}>
                          <SidebarMenuButton onClick={() => setPicked(d)} data-testid="device-item">
                            <OnlineDot online={online.includes(d)} />
                            <span className="min-w-0 flex-1 truncate">{d}</span>
                            {running > 0 && <span className="label shrink-0 normal-case">{running} running</span>}
                            <ChevronRightIcon />
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                ) : (
                  <p className="px-s3 text-sm text-muted-foreground">No devices yet. Run the controller on a computer to see it here.</p>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          ) : (
            <DeviceSessions
              key={device}
              device={device}
              online={online.includes(device)}
              sessions={sessions.filter((s) => deviceOf(s) === device)}
              selectedId={selectedId}
              onSelect={(id) => {
                onSelect(id)
                setOpenMobile(false)
              }}
              onBack={() => setPicked(null)}
            />
          )}
        </SidebarContent>
      </nav>
    </Sidebar>
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
  const [endedOpen, setEndedOpen] = useState(() => sessions.some((s) => s.id === selectedId && s.status === "ended" && !s.paused_at))
  const q = query.trim().toLowerCase()
  const matching = q ? sessions.filter((s) => sessionTitle(s).toLowerCase().includes(q)) : sessions
  // Paused sessions stay with the running ones until resumed or ended.
  const live = matching.filter((s) => s.status !== "ended" || s.paused_at)
  const allEnded = matching.filter((s) => s.status === "ended" && !s.paused_at)
  const ended = allEnded.slice(0, shown)
  const clash = clashingTitles(sessions)

  const item = (s: Session) => (
    <SidebarMenuItem key={s.id}>
      <SidebarMenuButton onClick={() => onSelect(s.id)} isActive={s.id === selectedId} aria-current={s.id === selectedId} data-testid="session-item" className="justify-between">
        <span className="truncate">
          {sessionTitle(s)}
          {clash(s) && <span className="ml-s2 text-muted-foreground" data-testid="session-started">{clash(s)}</span>}
        </span>
        {s.status === "ended" && !s.paused_at ? (
          <span className="label shrink-0 normal-case">{timeAgo(s.ended_at ?? s.updated_at)}</span>
        ) : (
          <StatusBadge status={shownStatus(s)} className="shrink-0 border-transparent px-0" />
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )

  return (
    <>
      <SidebarGroup className="gap-s2">
        <Button variant="ghost" size="sm" className="w-fit rounded-full text-muted-foreground" onClick={onBack} data-testid="devices-back">
          <ChevronLeftIcon /> Devices
        </Button>
        <p className="flex items-center gap-s2 px-s3 text-sm font-medium" data-testid="device-name">
          <OnlineDot online={online} />
          <span className="truncate">{device}</span>
        </p>
        {sessions.length > 8 && (
          <SidebarInput type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a session" aria-label="Find a session" data-testid="session-search" />
        )}
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel className="label">Running</SidebarGroupLabel>
        <SidebarGroupContent>
          {live.length ? (
            <SidebarMenu>{live.map(item)}</SidebarMenu>
          ) : (
            <p className="px-s3 text-sm text-muted-foreground">
              {q ? "No running session matches." : <>Nothing running. Start a session, or run <code className="font-mono">seraph claude</code> in a terminal.</>}
            </p>
          )}
        </SidebarGroupContent>
      </SidebarGroup>
      {ended.length > 0 && (
        <Collapsible open={endedOpen || !!q} onOpenChange={setEndedOpen} asChild>
          <SidebarGroup>
            <SidebarGroupLabel asChild className="label">
              <CollapsibleTrigger className="group/ended" data-testid="ended-toggle">
                <ChevronRightIcon className="transition-transform duration-[144ms] ease-slag group-data-[state=open]/ended:rotate-90" />
                Ended ({allEnded.length})
              </CollapsibleTrigger>
            </SidebarGroupLabel>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>{ended.map(item)}</SidebarMenu>
                {allEnded.length > shown && (
                  <Button variant="ghost" size="sm" className="mt-s2 rounded-full" onClick={() => setShown((n) => n + 30)}>
                    Show more ({allEnded.length - shown})
                  </Button>
                )}
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>
      )}
    </>
  )
}
