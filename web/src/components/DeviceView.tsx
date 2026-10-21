import { PlusIcon } from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldDescription } from "@/components/ui/field"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import type { Device } from "@/hooks/data"
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
  const mine = sessions.filter((s) => s.hostname === device.id)
  const running = mine.filter((s) => s.status !== "ended" || s.paused_at)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-s5 overflow-y-auto pb-s6" data-testid="device-view">
      <header className="flex flex-col gap-s2 border-b pb-s4">
        <div className="flex flex-wrap items-center gap-s4">
          <h1 className="text-title font-medium tracking-[-0.03em]" data-testid="device-title">{device.id}</h1>
          <Badge variant="outline" className="label gap-s2 normal-case" data-testid="device-status" data-active={device.active}>
            <span className={`size-2 rounded-full ${device.active ? "bg-success" : "bg-muted-foreground/50"}`} aria-hidden />
            {device.active ? "Active" : "Inactive"}
          </Badge>
        </div>
        <p className="label">
          {device.stopped_at ? `Stopped ${timeAgo(device.stopped_at)}` : `Checked in ${timeAgo(device.last_seen)}`}
          {device.version && ` · seraph ${device.version.split(" ")[0]}`}
          {` · ${running.length} running`}
        </p>
      </header>

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
