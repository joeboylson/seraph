import { FolderIcon, FolderPlusIcon } from "lucide-react"
import { FolderTree } from "./FolderTree"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { askDaemon } from "@/lib/commands"
import type { Controller, Session } from "@/lib/types"

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
  preset,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: Session[]
  machines: Controller[]
  /** Open on this computer and folder, e.g. from a device's screen. */
  preset?: { machine: string; cwd: string } | null
  onStarted: (id: string) => void
}) {
  // Default to the computer of the latest session, if it's on.
  const latest = sessions.find((s) => machines.some((m) => m.id === s.hostname))?.hostname
  const [chosen, setChosen] = useState<string | null>(null)
  const machine = machines.find((m) => m.id === chosen) ?? machines.find((m) => m.id === latest) ?? machines[0]
  const online = Boolean(machine)
  const [cwd, setCwd] = useState("")
  const [newFolder, setNewFolder] = useState("")
  const [name, setName] = useState("")
  const [model, setModel] = useState("default")
  const [mode, setMode] = useState("inherit")
  const [prompt, setPrompt] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const recent = [...new Set(sessions.filter((s) => s.hostname === machine?.id).map((s) => s.cwd))].slice(0, 6)

  // Opened from a device's folder: that computer and folder.
  useEffect(() => {
    if (open && preset) setChosen(preset.machine)
  }, [open, preset])

  // Each time it opens on a computer, start from the folder picked on its
  // screen, or its latest session's folder.
  useEffect(() => {
    if (open && machine) {
      setCwd(preset?.machine === machine.id ? preset.cwd : (recent[0] ?? ""))
      setError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, machine?.id, preset])

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

        {!online && (
          <Alert variant="destructive">
            <AlertDescription>
              The controller is offline. Run <code className="font-mono">seraph start</code> on your computer.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-s5">
          {/* Any computer that's on: its folders, its sessions. */}
          {machines.length > 0 && (
            <Field>
              <FieldLabel htmlFor="f-computer" className="label">Computer</FieldLabel>
              <Select value={machine?.id} onValueChange={setChosen}>
                <SelectTrigger id="f-computer" className="w-full" data-testid="machine"><SelectValue /></SelectTrigger>
                <SelectContent>{machines.map((m) => <SelectItem key={m.id} value={m.id}>{m.label || m.id}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          {recent.length > 0 && (
            <FieldSet>
              <FieldLegend variant="label" className="label">Recent</FieldLegend>
              <div className="flex flex-wrap gap-s3">
                {recent.map((path) => (
                  <Button key={path} variant="outline" size="sm" className="max-w-full rounded-full font-mono" onClick={() => setCwd(path)}>
                    <span className="truncate">{path.split("/").pop()}</span>
                  </Button>
                ))}
              </div>
            </FieldSet>
          )}

          <FieldSet className="gap-s3">
            <FieldLegend variant="label" className="label">Folder</FieldLegend>
            <InputGroup>
              <InputGroupAddon>
                <FolderIcon />
              </InputGroupAddon>
              <InputGroupInput
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="Pick one below, or type a path"
                className="font-mono"
                aria-label="Folder path"
                data-testid="cwd"
              />
            </InputGroup>
            {machine && (
              <FolderTree
                key={machine.id}
                machine={machine.id}
                selected={cwd}
                onSelect={(path) => {
                  setError(null)
                  setCwd(path)
                }}
                onError={setError}
              />
            )}
            <InputGroup>
              <InputGroupAddon>
                <FolderPlusIcon />
              </InputGroupAddon>
              <InputGroupInput value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="New folder inside this one (optional)" aria-label="New folder" data-testid="new-folder" />
            </InputGroup>
            <FieldDescription>
              Only folders this computer allows. Add more there with <code className="font-mono">seraph folders add &lt;folder&gt;</code>.
            </FieldDescription>
          </FieldSet>

          <div className="grid gap-s4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="f-model" className="label">Model</FieldLabel>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="f-model" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{MODELS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="f-permissions" className="label">Permissions</FieldLabel>
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger id="f-permissions" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{MODES.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>

          <Field>

            <FieldLabel htmlFor="f-name-optional" className="label">Name (optional)</FieldLabel>
            <Input id="f-name-optional" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. landing page" data-testid="session-name" />
          </Field>

          <Field>

            <FieldLabel htmlFor="f-first-message-optional" className="label">First message (optional)</FieldLabel>
            <Textarea id="f-first-message-optional" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="What should Claude do?" data-testid="first-prompt" />
          </Field>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
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
