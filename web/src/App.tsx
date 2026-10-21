import { BellIcon, LogOutIcon, PlusIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { Spinner } from "@/components/ui/spinner"
import { NewSessionDialog } from "@/components/NewSessionDialog"
import { DeviceView } from "@/components/DeviceView"
import { PinnedTabs } from "@/components/PinnedTabs"
import { SessionList } from "@/components/SessionList"
import { SessionView } from "@/components/SessionView"
import { useConnected, useDevices, useSessions } from "@/hooks/data"
import { useNotifications } from "@/hooks/useNotifications"
import { MAX_PINS, usePins } from "@/hooks/usePins"
import { onCommandError } from "@/lib/commands"
import { signOut } from "@/lib/push"

// What's open lives in the URL hash so links and reloads keep it:
// #/s/<session id> for a session, #/d/<computer> for a device.
function useHashRoute() {
  const read = () => {
    const session = location.hash.match(/^#\/s\/([\w-]+)/)?.[1] ?? null
    const device = location.hash.match(/^#\/d\/(.+)$/)?.[1]
    return { session, device: device ? decodeURIComponent(device) : null }
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onHash = () => setRoute(read())
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])
  return {
    route,
    select: (id: string) => (location.hash = `/s/${id}`),
    openDevice: (id: string) => (location.hash = `/d/${encodeURIComponent(id)}`),
  }
}

export default function App() {
  const { sessions, loading, reload } = useSessions()
  const devices = useDevices()
  const machines = useMemo(() => devices.filter((d) => d.active), [devices])
  const connected = useConnected()
  const { route, select, openDevice } = useHashRoute()
  const selectedId = route.session
  const [newOpen, setNewOpen] = useState(false)
  // Set when New session comes from a device's folder.
  const [preset, setPreset] = useState<{ machine: string; cwd: string } | null>(null)
  const { pins, toggle: togglePin, prune: prunePins } = usePins()

  // A deleted session's tab goes too.
  useEffect(() => {
    if (!loading) prunePins(new Set(sessions.map((s) => s.id)))
  }, [loading, sessions, prunePins])

  useEffect(() => onCommandError((message) => toast.error(message, { duration: 8000 })), [])

  const selected = sessions.find((s) => s.id === selectedId) ?? null

  // A session we just started may not have reached us over Realtime yet.
  useEffect(() => {
    if (!selectedId || selected || loading) return
    const t = setInterval(reload, 2000)
    return () => clearInterval(t)
  }, [selectedId, selected, loading, reload])
  const notifications = useNotifications(sessions, select)

  // With nothing chosen, open the most recent running session.
  useEffect(() => {
    if (!selectedId && !route.device && sessions.length) {
      const first = sessions.find((s) => s.status !== "ended") ?? sessions[0]
      select(first.id)
    }
  }, [selectedId, route.device, sessions, select])
  const device = route.device ? devices.find((d) => d.id === route.device) : undefined

  return (
    // One screen tall: the bars stay put and only the content inside scrolls.
    <SidebarProvider className="h-dvh min-h-0 overflow-hidden">
      <SessionList
        sessions={sessions}
        selectedId={selectedId}
        devices={devices}
        openDevice={route.device}
        onSelect={select}
        onOpenDevice={openDevice}
        onNew={() => {
          setPreset(null)
          setNewOpen(true)
        }}
      />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden px-s4 md:px-s5">
        <header className="flex shrink-0 items-center justify-between gap-s4 py-s4">
          <div className="flex min-w-0 items-center gap-s3">
            <SidebarTrigger className="-ml-s2 shrink-0" aria-label="Sessions" title="Sessions" />
            {pins.length ? (
              <PinnedTabs sessions={sessions} pins={pins} selectedId={selectedId} onSelect={select} onUnpin={togglePin} />
            ) : (
              <span className="font-medium">Seraph</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-s4">
            {notifications.ask && (
              <Button variant="ghost" size="sm" className="rounded-full" onClick={notifications.ask}>
                <BellIcon /> Notify me
              </Button>
            )}
            {!connected && (
              <Badge variant="outline" className="label gap-s2" data-testid="connection-lost" role="status">
                <Spinner className="size-3 text-warning" />
                Reconnecting…
              </Badge>
            )}
            <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setNewOpen(true)} aria-label="New session" title="New session" data-testid="header-new-session">
              <PlusIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => signOut()} aria-label="Sign out" title="Sign out">
              <LogOutIcon />
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col pt-s5">
          {route.device ? (
            device ? (
              <DeviceView
                key={device.id}
                device={device}
                sessions={sessions}
                onOpen={select}
                onNewSession={(machine, cwd) => {
                  setPreset({ machine, cwd })
                  setNewOpen(true)
                }}
              />
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No computer called {route.device}</EmptyTitle>
                  <EmptyDescription>It hasn't run seraph with this Supabase.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )
          ) : selected ? (
            <SessionView
              key={selected.id}
              session={selected}
              onOpen={select}
              onDeleted={() => (location.hash = "")}
              pinned={pins.includes(selected.id)}
              canPin={pins.length < MAX_PINS}
              onTogglePin={() => togglePin(selected.id)}
              hostOnline={!!selected.hostname && machines.some((m) => m.id === selected.hostname)}
            />
          ) : loading || selectedId ? (
            <Empty>
              <EmptyHeader>
                <Spinner />
                <EmptyTitle>{loading ? "Loading…" : "Opening session…"}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle className="text-title">No sessions yet</EmptyTitle>
                <EmptyDescription>
                  Start one here, or run <code className="font-mono">seraph claude</code> in a terminal on your Mac.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button className="rounded-full" onClick={() => setNewOpen(true)}>New session</Button>
              </EmptyContent>
            </Empty>
          )}
        </div>
      </SidebarInset>

      <Toaster position="bottom-center" />
      <NewSessionDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        sessions={sessions}
        machines={machines}
        preset={preset}
        onStarted={select}
      />
    </SidebarProvider>
  )
}
