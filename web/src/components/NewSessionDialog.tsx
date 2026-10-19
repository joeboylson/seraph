import { ChevronUpIcon, FolderIcon, FolderPlusIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { askDaemon } from "@/lib/commands"
import type { Controller, Session } from "@/lib/types"

type Listing = { path: string; parent: string; dirs: string[]; missing?: string; machine?: string }

const MODELS = [
  ["default", "Default model"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
] as const

// "inherit" leaves the flag off, so Claude uses your own default mode.
const MODES = [
  ["inherit", "Your default"],
  ["default", "Ask before edits"],
  ["acceptEdits", "Accept edits"],
  ["plan", "Plan mode"],
  ["auto", "Auto"],
  ["bypassPermissions", "Bypass permissions"],
] as const

export function NewSessionDialog({
  open,
  onOpenChange,
  sessions,
  machines,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: Session[]
  machines: Controller[]
  onStarted: (id: string) => void
}) {
  // Default to the computer of the latest session, if it's on.
  const latest = sessions.find((s) => machines.some((m) => m.id === s.hostname))?.hostname
  const [chosen, setChosen] = useState<string | null>(null)
  const machine = machines.find((m) => m.id === chosen) ?? machines.find((m) => m.id === latest) ?? machines[0]
  const online = Boolean(machine)
  const home = machine?.home
  const [listing, setListing] = useState<Listing | null>(null)
  const [cwd, setCwd] = useState("")
  const [newFolder, setNewFolder] = useState("")
  const [name, setName] = useState("")
  const [model, setModel] = useState("default")
  const [mode, setMode] = useState("inherit")
  const [prompt, setPrompt] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const recent = [...new Set(sessions.filter((s) => s.hostname === machine?.id).map((s) => s.cwd))].slice(0, 6)

  async function browse(path?: string, quietIfMissing = false) {
    setError(null)
    try {
      const result = await askDaemon<Listing>("list_dirs", { path: path ?? home ?? "~" }, machine!.id)
      // The latest session's folder may be gone; just open home instead.
      if (result.missing && quietIfMissing) return browse(home ?? "~")
      setListing({ ...result, machine: machine!.id })
      setCwd(result.path)
      if (result.missing) setError(`${result.missing} doesn't exist any more. Showing ${result.path} instead.`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // Browse again whenever the dialog opens on a different computer.
  useEffect(() => {
    if (open && machine && listing?.machine !== machine.id) browse(recent[0], true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, machine?.id])

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const folder = newFolder.trim() ? `${cwd}/${newFolder.trim()}` : cwd
      const { session_id } = await askDaemon<{ session_id: string }>(
        "start_session",
        {
          cwd: folder,
          create: Boolean(newFolder.trim()),
          name: name.trim() || undefined,
          model: model === "default" ? undefined : model,
          permission_mode: mode === "inherit" ? undefined : mode,
          prompt: prompt.trim() || undefined,
        },
        machine!.id,
      )
      onStarted(session_id)
      onOpenChange(false)
      setPrompt("")
      setName("")
      setNewFolder("")
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[610px]">
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>Starts Claude on {machines.length > 1 ? "the computer" : "your computer"} in the folder you pick.</DialogDescription>
        </DialogHeader>

        {!online && <p className="text-sm text-destructive">The controller is offline. Run <code className="font-mono">seraph start</code> on your computer.</p>}

        <div className="flex flex-col gap-s5">
          {machines.length > 1 && (
            <label className="flex flex-col gap-s2">
              <span className="label">Computer</span>
              <Select value={machine?.id} onValueChange={(id) => { setChosen(id); setListing(null) }}>
                <SelectTrigger className="w-full" data-testid="machine"><SelectValue /></SelectTrigger>
                <SelectContent>{machines.map((m) => <SelectItem key={m.id} value={m.id}>{m.id}</SelectItem>)}</SelectContent>
              </Select>
            </label>
          )}
          {recent.length > 0 && (
            <section>
              <p className="label pb-s3">Recent</p>
              <div className="flex flex-wrap gap-s3">
                {recent.map((path) => (
                  <Button key={path} variant="outline" size="sm" className="max-w-full rounded-full font-mono" onClick={() => browse(path)}>
                    <span className="truncate">{path.split("/").pop()}</span>
                  </Button>
                ))}
              </div>
            </section>
          )}

          <section>
            <p className="label pb-s3">Folder</p>
            <div className="rounded-lg border">
              <div className="flex items-center gap-s3 border-b px-s4 py-s3">
                <Button variant="ghost" size="icon-sm" disabled={!listing || listing.path === listing.parent} onClick={() => browse(listing?.parent)} aria-label="Up one folder">
                  <ChevronUpIcon />
                </Button>
                <Input
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      browse(cwd)
                    }
                  }}
                  onBlur={() => listing && cwd !== listing.path && browse(cwd)}
                  className="h-8 border-0 px-s2 font-mono shadow-none focus-visible:ring-0"
                  aria-label="Folder path"
                  data-testid="cwd"
                />
              </div>
              <ul className="max-h-56 overflow-y-auto py-s2" data-testid="folders">
                {listing?.dirs.map((dir) => (
                  <li key={dir}>
                    <button type="button" className="flex w-full items-center gap-s3 px-s4 py-s2 text-left text-sm hover:bg-accent" onClick={() => browse(`${listing.path}/${dir}`)}>
                      <FolderIcon className="size-4 text-muted-foreground" /> {dir}
                    </button>
                  </li>
                ))}
                {listing && !listing.dirs.length && <li className="px-s4 py-s2 text-sm text-muted-foreground">No folders here</li>}
              </ul>
              <div className="flex items-center gap-s3 border-t px-s4 py-s3">
                <FolderPlusIcon className="size-4 shrink-0 text-muted-foreground" />
                <Input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="New folder inside this one (optional)" className="h-8" data-testid="new-folder" />
              </div>
            </div>
          </section>

          <div className="grid gap-s4 sm:grid-cols-2">
            <label className="flex flex-col gap-s2">
              <span className="label">Model</span>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{MODELS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-s2">
              <span className="label">Permissions</span>
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{MODES.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </label>
          </div>

          <label className="flex flex-col gap-s2">
            <span className="label">Name (optional)</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. landing page" data-testid="session-name" />
          </label>

          <label className="flex flex-col gap-s2">
            <span className="label">First message (optional)</span>
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="What should Claude do?" data-testid="first-prompt" />
          </label>

          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>

        {/* Pinned so Start is always on screen while the form scrolls. */}
        <DialogFooter className="sticky -bottom-4 bg-popover">
          <Button className="rounded-full" onClick={start} disabled={busy || !online || !cwd} data-testid="start-session">
            {busy ? "Starting…" : "Start session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
