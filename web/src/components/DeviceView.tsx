import { DownloadIcon, PencilIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldDescription } from "@/components/ui/field"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Toggle } from "@/components/ui/toggle"
import { olderThan, useDeviceLogs, useLatestRelease, type Device } from "@/hooks/data"
import { askDaemon, renameDevice, setAutoUpdate } from "@/lib/commands"
import type { Session } from "@/lib/types"
import { timeAgo } from "@/lib/utils"
import { FolderTree } from "./FolderTree"
import { sessionTitle } from "./SessionList"
import { StatusBadge, shownStatus } from "./StatusBadge"

/**
 * One computer: whether it's active, its folders (only the ones seraph may
 * use there) to start a session in, and its sessions.
 */
export function DeviceView({
  device,
  sessions,
  onOpen,
  onNewSession,
}: {
  device: Device
  sessions: Session[]
  onOpen: (sessionId: string) => void
  onNewSession: (machine: string, cwd: string) => void
}) {
  const [folder, setFolder] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const latest = useLatestRelease()
  const behind = Boolean(latest && device.version && olderThan(device.version, latest))

  // Things to fix about this computer's setup.
  const warnings: { id: string; text: React.ReactNode }[] = []
  if (behind) warnings.push({ id: "version", text: <>It runs seraph {device.version?.split(" ")[0]}; {latest} is out.</> })
  if (device.info && !device.info.folders?.length)
    warnings.push({
      id: "folders",
      text: (
        <>
          No allowed folders set, so the page can browse its whole home folder. On it, narrow that with <code className="font-mono">seraph folders add &lt;folder&gt;</code>.
        </>
      ),
    })
  if (device.info && device.info.at_login === false)
    warnings.push({
      id: "login",
      text: (
        <>
          Its controller won't start again after a restart. On it, run <code className="font-mono">seraph service install</code>.
        </>
      ),
    })

  async function update() {
    setUpdating(true)
    try {
      await askDaemon("update", {}, device.id)
      toast.success(`${device.id} is updating. Its controller restarts in a minute; sessions keep running.`)
    } catch (e) {
      toast.error(`Couldn't update ${device.id}: ${(e as Error).message}`)
    } finally {
      setUpdating(false)
    }
  }
  const mine = sessions.filter((s) => s.hostname === device.id)
  const running = mine.filter((s) => s.status !== "ended" || s.paused_at)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-s5 overflow-y-auto pb-s6" data-testid="device-view">
      <header className="flex flex-col gap-s2 border-b pb-s4">
        <div className="flex flex-wrap items-center gap-s4">
          <h1 className="text-title font-medium tracking-[-0.03em]" data-testid="device-title">{device.label || device.id}</h1>
          <RenameDevice device={device} />
          <Badge variant="outline" className="label gap-s2 normal-case" data-testid="device-status" data-active={device.active}>
            <span className={`size-2 rounded-full ${device.active ? "bg-success" : "bg-muted-foreground/50"}`} aria-hidden />
            {device.active ? "Active" : "Inactive"}
          </Badge>
        </div>
        {device.label && <p className="font-mono text-sm text-muted-foreground" data-testid="device-hostname">{device.id}</p>}
        <p className="label">
          {device.stopped_at ? `Stopped ${timeAgo(device.stopped_at)}` : `Checked in ${timeAgo(device.last_seen)}`}
          {device.version && ` · seraph ${device.version.split(" ")[0]}`}
          {` · ${running.length} running`}
        </p>
      </header>

      <div className="flex items-center gap-s3">
        <Switch
          id="auto-update"
          checked={Boolean(device.auto_update)}
          onCheckedChange={(on) => setAutoUpdate(device.id, on).catch(() => {})}
          data-testid="auto-update"
        />
        <Label htmlFor="auto-update" className="text-sm font-normal">
          Install new releases by itself <span className="text-muted-foreground">(checks every hour; sessions keep running)</span>
        </Label>
      </div>

      {warnings.length > 0 && (
        <Alert data-testid="device-warnings">
          <TriangleAlertIcon />
          <AlertTitle>Worth fixing</AlertTitle>
          <AlertDescription>
            <ul className="flex list-disc flex-col gap-s1 pl-s4">
              {warnings.map((w) => (
                <li key={w.id} data-testid={`warning-${w.id}`}>
                  {w.text}
                </li>
              ))}
            </ul>
            {behind &&
              (device.active ? (
                <Button size="sm" className="mt-s3 rounded-full" onClick={update} disabled={updating} data-testid="device-update">
                  <DownloadIcon /> {updating ? "Asking…" : `Update to ${latest}`}
                </Button>
              ) : (
                <p className="pt-s2">
                  It's inactive, so update it there: <code className="font-mono">seraph update</code>
                </p>
              ))}
          </AlertDescription>
        </Alert>
      )}

      {device.active ? (
        <section className="flex flex-col gap-s3">
          <p className="label">Start a session</p>
          <FolderTree machine={device.id} selected={folder} onSelect={setFolder} onError={setError} />
          <FieldDescription>
            Only folders {device.id} allows. Add more there with <code className="font-mono">seraph folders add &lt;folder&gt;</code>.
          </FieldDescription>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button className="w-fit rounded-full" disabled={!folder} onClick={() => onNewSession(device.id, folder)} data-testid="device-new-session">
            <PlusIcon /> New session {folder && <span className="font-mono">in {folder.split("/").pop()}</span>}
          </Button>
        </section>
      ) : (
        <Alert data-testid="device-inactive">
          <AlertDescription>
            <span>
              {device.id} hasn't checked in for over an hour, or its controller was stopped. On it, run <code className="font-mono">seraph start</code> to
              browse its folders and start or resume sessions there.
            </span>
          </AlertDescription>
        </Alert>
      )}

      <DeviceLogs machine={device.id} />

      {mine.length > 0 && (
        <section className="flex flex-col gap-s3">
          <p className="label">Sessions</p>
          <ItemGroup className="gap-s2">
            {mine.slice(0, 20).map((s) => (
              <Item key={s.id} variant="outline" size="sm" asChild>
                <button type="button" onClick={() => onOpen(s.id)} className="w-full text-left" data-testid="device-session">
                  <ItemContent>
                    <ItemTitle>{sessionTitle(s)}</ItemTitle>
                    <ItemDescription className="font-mono text-xs">{s.cwd}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {s.status === "ended" && !s.paused_at ? <span className="label normal-case">{timeAgo(s.ended_at ?? s.updated_at)}</span> : <StatusBadge status={shownStatus(s)} />}
                  </ItemActions>
                </button>
              </Item>
            ))}
          </ItemGroup>
        </section>
      )}
    </div>
  )
}

// Lines that say something went wrong.
const PROBLEM = /error|fail|panic|timed out|refused|unreachable|expired|http \d{3}/i

/** The computer's newest log lines, as its controller uploaded them. */
function DeviceLogs({ machine }: { machine: string }) {
  const { lines, reload } = useDeviceLogs(machine)
  const [problemsOnly, setProblemsOnly] = useState(false)
  const shown = (lines ?? []).filter((l) => !problemsOnly || PROBLEM.test(l.line))
  return (
    <section className="flex flex-col gap-s3" data-testid="device-logs">
      <div className="flex items-center gap-s3">
        <p className="label">Recent activity</p>
        <Toggle size="sm" variant="outline" className="rounded-full" pressed={problemsOnly} onPressedChange={setProblemsOnly} data-testid="logs-problems">
          Problems only
        </Toggle>
        <Button variant="ghost" size="icon-sm" className="rounded-full" onClick={reload} aria-label="Refresh" title="Refresh">
          <RefreshCwIcon />
        </Button>
      </div>
      <div className="max-h-72 overflow-y-auto rounded-lg border p-s3 font-mono text-xs">
        {lines === null ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : shown.length ? (
          shown.map((l) => (
            <p key={l.id} className={PROBLEM.test(l.line) ? "text-destructive" : undefined} data-testid="log-line">
              <span className="text-muted-foreground">{l.ts ? new Date(l.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) : l.source}</span> {l.line}
            </p>
          ))
        ) : (
          <p className="text-muted-foreground">{problemsOnly ? "No problems logged." : "Nothing logged yet. Logs arrive about once a minute."}</p>
        )}
      </div>
    </section>
  )
}

/** Give the computer a name for the page; its hostname stays underneath. */
function RenameDevice({ device }: { device: Device }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setName(device.label ?? "")
        setOpen(o)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="-ml-s3 text-muted-foreground" aria-label="Rename device" title="Rename" data-testid="rename-device">
          <PencilIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[377px]">
        <form
          className="flex flex-col gap-s4"
          onSubmit={(e) => {
            e.preventDefault()
            renameDevice(device.id, name).catch(() => {})
            setOpen(false)
          }}
        >
          <DialogHeader>
            <DialogTitle>Name {device.id}</DialogTitle>
          </DialogHeader>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={device.id} autoFocus aria-label="Device name" data-testid="device-name-input" />
          <p className="text-sm text-muted-foreground">Leave it empty to go back to {device.id}.</p>
          <DialogFooter>
            <Button type="submit" className="rounded-full" data-testid="device-name-save">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
