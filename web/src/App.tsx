import { BellIcon, LogOutIcon, MenuIcon, PlusIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { NewSessionDialog } from "@/components/NewSessionDialog"
import { SessionList } from "@/components/SessionList"
import { SessionView } from "@/components/SessionView"
import { useConnected, useMachines, useSessions } from "@/hooks/data"
import { useNotifications } from "@/hooks/useNotifications"
import { onCommandError } from "@/lib/commands"
import { signOut } from "@/lib/push"

// The open session lives in the URL hash so links and reloads keep it.
function useHashSession() {
  const read = () => location.hash.match(/^#\/s\/([\w-]+)/)?.[1] ?? null
  const [id, setId] = useState(read)
  useEffect(() => {
    const onHash = () => setId(read())
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])
  return [id, (next: string) => (location.hash = `/s/${next}`)] as const
}

export default function App() {
  const { sessions, loading, reload } = useSessions()
  const machines = useMachines()
  const online = machines.length > 0
  const connected = useConnected()
  const [selectedId, select] = useHashSession()
  const [newOpen, setNewOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  useEffect(
    () =>
      onCommandError((message) => {
        setSendError(message)
        setTimeout(() => setSendError(null), 8000)
      }),
    [],
  )

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
    if (!selectedId && sessions.length) {
      const first = sessions.find((s) => s.status !== "ended") ?? sessions[0]
      select(first.id)
    }
  }, [selectedId, sessions, select])

  const list = (
    <SessionList
      sessions={sessions}
      selectedId={selectedId}
      online={machines.map((m) => m.id)}
      onSelect={(id) => {
        select(id)
        setMenuOpen(false)
      }}
      onNew={() => {
        setNewOpen(true)
        setMenuOpen(false)
      }}
    />
  )

  return (
    // One screen tall: the bars stay put and only the content inside scrolls.
    <div className="mx-auto flex h-dvh max-w-[1597px] flex-col overflow-hidden px-s4 md:px-s5">
      <header className="flex shrink-0 items-center justify-between gap-s4 py-s4">
        <div className="flex items-center gap-s3">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMenuOpen(true)} aria-label="Sessions">
            <MenuIcon />
          </Button>
          <span className="font-medium">Seraph</span>
        </div>
        <div className="flex items-center gap-s4">
          {notifications.ask && (
            <Button variant="ghost" size="sm" className="rounded-full" onClick={notifications.ask}>
              <BellIcon /> Notify me
            </Button>
          )}
          {connected ? (
            <span className="label inline-flex min-w-0 items-center gap-s3" data-testid="controller-status" data-online={online}>
              <span className={`size-2 shrink-0 rounded-full ${online ? "bg-success" : "bg-destructive"}`} aria-hidden />
              <span className="truncate" title={machines.map((m) => m.id).join(", ")}>
                {machines.length > 1 ? `${machines.length} computers` : online ? machines[0].id : "Controller offline"}
              </span>
            </span>
          ) : (
            <span className="label inline-flex items-center gap-s3" data-testid="connection-lost" role="status">
              <span className="size-2 animate-pulse rounded-full bg-warning" aria-hidden />
              Reconnecting…
            </span>
          )}
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setNewOpen(true)} aria-label="New session" title="New session" data-testid="header-new-session">
            <PlusIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => signOut()} aria-label="Sign out" title="Sign out">
            <LogOutIcon />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-s6">
        <aside className="hidden w-[233px] shrink-0 overflow-y-auto overscroll-contain border-r py-s5 pr-s4 md:block">{list}</aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col pt-s5">
          {selected ? (
            <SessionView key={selected.id} session={selected} onOpen={select} onDeleted={() => (location.hash = "")} />
          ) : (
            <div className="flex flex-col gap-s4 overflow-y-auto py-s8">
              <h1 className="text-title font-medium tracking-[-0.03em]">
                {loading ? "Loading…" : selectedId ? "Opening session…" : "No sessions yet"}
              </h1>
              {!loading && !selectedId && (
                <p className="max-w-[610px] text-lead text-muted-foreground">
                  Start one here, or run <code className="font-mono">seraph claude</code> in a terminal on your Mac.
                </p>
              )}
              <Button className="w-fit rounded-full" onClick={() => setNewOpen(true)}>New session</Button>
            </div>
          )}
        </main>
      </div>

      {sendError && (
        <p role="alert" className="fixed inset-x-s4 bottom-s4 z-50 mx-auto max-w-[610px] rounded-lg border border-destructive bg-background px-s4 py-s3 text-sm text-destructive">
          {sendError}
        </p>
      )}

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-[289px] p-s5">
          <SheetTitle className="sr-only">Sessions</SheetTitle>
          <div className="pt-s6">{list}</div>
        </SheetContent>
      </Sheet>

      <NewSessionDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        sessions={sessions}
        machines={machines}
        onStarted={select}
      />
    </div>
  )
}
