import { PauseIcon, PencilIcon, PinIcon, PinOffIcon, PowerIcon, RotateCcwIcon, RotateCwIcon, Trash2Icon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceLine, TraceTitle } from "@/components/ui/trace"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useMessages, useSentPrompts, useSessionEvents } from "@/hooks/data"
import { askDaemon, deleteSession, endPaused, pauseSession, renameSession, sendCommand, sendKeys } from "@/lib/commands"
import { readMode, readPrompt, type Prompt } from "@/lib/screen"
import { dropMirror, getMirror } from "@/lib/terminal"
import { contextTokens, fileChanges, latestTodos, shortPath, type Todo } from "@/lib/tools"
import type { Session } from "@/lib/types"
import { ChangesView } from "./ChangesView"
import { ChatView } from "./ChatView"
import { Composer } from "./Composer"
import { PromptCard, promptKey } from "./PromptCard"
import { sessionTitle } from "./SessionList"
import { StatusBadge, shownStatus } from "./StatusBadge"
import { TerminalView } from "./TerminalView"
import { UsageBars } from "./UsageBars"
import { Todos } from "./ToolCard"

const MODE_LABELS: Record<string, string> = {
  default: "Ask before edits",
  acceptEdits: "Accept edits",
  plan: "Plan mode",
  auto: "Auto",
  bypassPermissions: "Bypass permissions",
  dontAsk: "Don't ask",
}

// The only part of a session that scrolls; the bars above and below stay put.
const SCROLL = "min-h-0 flex-1 overflow-y-auto overscroll-contain"

const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

/** Claude's todo list, folded to one line above the message box. */
function PlanBar({ todos }: { todos: Todo[] }) {
  const current = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending")
  const done = todos.filter((t) => t.status === "completed").length
  return (
    <Trace data-testid="plan">
      <TraceCollapsible>
        <TraceCollapsibleTrigger className="w-full">
          <TraceLine status={current?.status === "in_progress" ? "running" : undefined} className="min-w-0 flex-1 text-foreground">
            <TraceTitle className="flex-1">{current?.status === "in_progress" ? current.activeForm ?? current.content : current?.content}</TraceTitle>
            <TraceDescription className="font-mono text-xs">
              {done}/{todos.length}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="max-h-[40dvh] overflow-auto text-foreground">
          <Todos todos={todos} />
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

/** A button that asks before it acts. */
function Confirm({
  title,
  description,
  action,
  onConfirm,
  children,
  open,
  onOpenChange,
}: {
  title: string
  description?: string
  action: string
  onConfirm: () => void
  children?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {children && <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" className="rounded-full" onClick={onConfirm} data-testid="confirm">
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The power button: pause, restart or end, like a laptop's. Only sessions
 * started from the page can pause or restart; a terminal's can only end. */
function PowerMenu({ session, headless, onRestart }: { session: Session; headless: boolean; onRestart: () => void }) {
  const [asking, setAsking] = useState<"restart" | "end" | null>(null)
  const close = (open: boolean) => !open && setAsking(null)
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="rounded-full" aria-label="Power" title="Pause, restart or end" data-testid="power">
            <PowerIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {headless && (
            <>
              <DropdownMenuItem onSelect={() => pauseSession(session.id).catch(() => {})} data-testid="pause-session">
                <PauseIcon /> Pause
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAsking("restart")} data-testid="restart-session">
                <RotateCwIcon /> Restart
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem variant="destructive" onSelect={() => setAsking("end")} data-testid="end-session">
            <PowerIcon /> End session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Confirm
        open={asking === "restart"}
        onOpenChange={close}
        title="Restart this session?"
        description="Claude stops, then starts again in the same folder and picks the conversation back up. Anything it's in the middle of is lost."
        action="Restart"
        onConfirm={onRestart}
      />
      <Confirm open={asking === "end"} onOpenChange={close} title="End this session?" action="End session" onConfirm={() => sendCommand(session.id, "kill")} />
    </>
  )
}

function RenameButton({ session }: { session: Session }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setName(session.name ?? sessionTitle(session))
        setOpen(o)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="-ml-s3 shrink-0 text-muted-foreground" aria-label="Rename session" title="Rename" data-testid="rename">
          <PencilIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[377px]">
        <form
          className="flex flex-col gap-s4"
          onSubmit={(e) => {
            e.preventDefault()
            renameSession(session.id, name).catch(() => {})
            setOpen(false)
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Session name" data-testid="rename-input" />
          <DialogFooter>
            <Button type="submit" className="rounded-full" data-testid="rename-save">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function SessionView({
  session,
  onOpen,
  onDeleted,
  pinned,
  canPin,
  onTogglePin,
}: {
  session: Session
  onOpen: (id: string) => void
  onDeleted: () => void
  pinned: boolean
  canPin: boolean
  onTogglePin: () => void
}) {
  const ended = session.status === "ended"
  // Paused: Claude is stopped (or stopping) but the session waits to be resumed.
  const paused = !!session.paused_at
  // A linked session is followed through its transcript only: there's no
  // terminal to mirror or type into.
  const linked = session.mode === "linked"
  // Only sessions started from the page can be restarted from it; a terminal's
  // session belongs to that terminal.
  const headless = session.mode === "headless"
  const { messages, loading } = useMessages(session.id, session.status === "working")
  const events = useSessionEvents(session.id)
  const sent = useSentPrompts(session.id)
  const mirror = useMemo(
    () => (ended || linked ? null : getMirror(session.id, session.cols ?? 120, session.rows ?? 40)),
    [session.id, ended, linked, session.cols, session.rows],
  )
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [tab, setTab] = useState("chat")
  const [resuming, setResuming] = useState(false)

  // Watch the screen for a menu waiting on an answer, and for the
  // permission mode in Claude's status line (no hook reports mode changes).
  const [screenMode, setScreenMode] = useState<string | null>(null)
  useEffect(() => {
    if (!mirror) return setPrompt(null)
    const scan = () => {
      const lines = mirror.screenLines()
      setPrompt(readPrompt(lines))
      const mode = readMode(lines)
      if (mode) setScreenMode(mode)
    }
    scan()
    return mirror.onChange(scan)
  }, [mirror])
  const modeLabel = screenMode ?? (session.permission_mode && MODE_LABELS[session.permission_mode]) ?? null

  const lastPermission = [...events].reverse().find((e) => e.hook_event === "PermissionRequest" || e.hook_event === "PostToolUse")
  const permission = lastPermission?.hook_event === "PermissionRequest" ? lastPermission : undefined

  // A restarted session's Claude starts its screen afresh; don't keep the old one.
  useEffect(() => {
    if (ended) dropMirror(session.id)
  }, [ended, session.id])

  async function resume() {
    setResuming(true)
    try {
      // On the computer the session ran on: that's where its folder and history are.
      // One started from the page carries on in place; one from a terminal
      // continues as a new session started from the page.
      const { session_id } = await askDaemon<{ session_id: string }>(
        headless ? "restart_session" : "start_session",
        headless ? { session_id: session.id } : { cwd: session.cwd, resume: session.claude_session_id, name: session.name },
        session.hostname ?? "",
      )
      onOpen(session_id)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setResuming(false)
    }
  }

  async function restart() {
    try {
      await askDaemon("restart_session", { session_id: session.id }, session.hostname ?? "")
    } catch (e) {
      toast.error(`Couldn't restart: ${(e as Error).message}`)
    }
  }

  const todos = useMemo(() => latestTodos(messages), [messages])
  const context = useMemo(() => contextTokens(messages), [messages])
  const changes = useMemo(() => fileChanges(messages), [messages])
  const origin = session.mode === "headless" ? "Started from web" : linked ? "Linked, read-only" : `Terminal on ${session.hostname ?? "this Mac"}`

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-w-0 shrink-0 flex-col gap-s1 border-b pb-s4">
        <div className="flex min-w-0 items-center gap-s4">
          <h1 className="min-w-0 truncate text-title font-medium tracking-[-0.03em]" data-testid="session-title">{sessionTitle(session)}</h1>
          <RenameButton session={session} />
          <Button
            variant="ghost"
            size="icon-sm"
            className="-ml-s3 shrink-0 text-muted-foreground"
            onClick={onTogglePin}
            disabled={!pinned && !canPin}
            aria-pressed={pinned}
            aria-label={pinned ? "Unpin from the top" : "Pin to the top"}
            title={pinned ? "Unpin from the top" : canPin ? "Pin to the top" : "Five are pinned. Unpin one first."}
            data-testid="pin"
          >
            {pinned ? <PinOffIcon /> : <PinIcon />}
          </Button>
          <StatusBadge status={shownStatus(session)} className="shrink-0" />
        </div>
        {/* Cut from the left so the project folder stays visible. */}
        <p className="truncate text-left font-mono text-sm text-muted-foreground [direction:rtl]" title={session.cwd}>
          <bdi>{shortPath(session.cwd)}</bdi>
        </p>
        <p className="label" data-testid="session-meta">
          {session.model && !ended && !linked ? (
            <Button variant="link" className="label h-auto p-0 underline decoration-dotted" onClick={() => sendCommand(session.id, "prompt", { text: "/model" })} title="Change model" data-testid="model">
              {session.model}
            </Button>
          ) : (
            session.model
          )}
          {session.model && " · "}
          {[context ? `${formatTokens(context)} context` : null, origin].filter(Boolean).join(" · ")}
        </p>
        <UsageBars usage={session.usage} />
      </header>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-s3 pt-s4">
          <TabsList className="w-fit">
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="changes" data-testid="changes-tab">
              Changes{changes.length > 0 && <Badge variant="secondary" className="font-mono">{changes.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="terminal" disabled={!mirror} data-testid="terminal-tab">Terminal</TabsTrigger>
          </TabsList>
          <div className="flex min-w-0 gap-s2">
            {!ended && !linked && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-w-0 rounded-full"
                  onClick={() => sendKeys(session.id, ["ShiftTab"])}
                  title="Switch permission mode (Shift+Tab)"
                  data-testid="mode"
                >
                  <span className="truncate">{modeLabel ?? "Mode"}</span>
                </Button>
                {!paused && <PowerMenu session={session} headless={headless} onRestart={restart} />}
              </>
            )}
            {ended && paused && (
              <Confirm title="End this session?" description="It moves to the ended sessions. You can still resume it from there." action="End session" onConfirm={() => endPaused(session.id).catch(() => {})}>
                <Button variant="outline" size="sm" className="rounded-full" aria-label="End session" title="End session" data-testid="end-paused">
                  <PowerIcon /> <span className="hidden sm:inline">End</span>
                </Button>
              </Confirm>
            )}
            {ended && !paused && (
              <Confirm
                title="Delete this session?"
                description="Its conversation is removed from Supabase. The files Claude changed stay as they are."
                action="Delete"
                onConfirm={() => deleteSession(session.id).then(onDeleted, () => {})}
              >
                <Button variant="outline" size="sm" className="rounded-full" aria-label="Delete session" title="Delete session" data-testid="delete-session">
                  <Trash2Icon />
                </Button>
              </Confirm>
            )}
            {ended && (session.claude_session_id || headless) && (
              <Button size="sm" className="rounded-full" onClick={resume} disabled={resuming} data-testid="resume">
                <RotateCcwIcon /> {resuming ? "Resuming…" : "Resume"}
              </Button>
            )}
          </div>
        </div>
        <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col">
          <ChatView messages={messages} sent={sent} working={session.status === "working"} loading={loading} cwd={session.cwd} />
        </TabsContent>
        <TabsContent value="changes" className={SCROLL}>
          <ChangesView files={changes} cwd={session.cwd} />
        </TabsContent>
        <TabsContent value="terminal" className={SCROLL}>
          {mirror && <TerminalView mirror={mirror} sessionId={session.id} readOnly={ended} />}
        </TabsContent>
      </Tabs>

      <div className="flex shrink-0 flex-col gap-s3 border-t bg-background pt-s3 pb-[max(var(--spacing-s4),env(safe-area-inset-bottom))]">
        {todos && !ended && !prompt && todos.some((t) => t.status !== "completed") && tab === "chat" && <PlanBar todos={todos} />}
        {prompt && mirror && tab === "chat" && (
          <PromptCard key={promptKey(prompt)} prompt={prompt} sessionId={session.id} permission={permission} mirror={mirror} cwd={session.cwd} />
        )}
        {!prompt && session.status === "waiting" && tab === "chat" && mirror && (
          <Alert data-testid="waiting-hint">
            <AlertDescription>
              <span>
                Claude is waiting on you.{" "}
                <Button variant="link" className="h-auto p-0 text-sm underline" onClick={() => setTab("terminal")}>Open the terminal</Button> to answer.
              </span>
            </AlertDescription>
          </Alert>
        )}
        {linked && !ended ? (
          <Alert data-testid="linked-note">
            <AlertDescription>
              <span>
                Read-only. To control this session from here, exit it and run <code className="font-mono">seraph resume {session.claude_session_id?.slice(0, 8)}</code>
              </span>
            </AlertDescription>
          </Alert>
        ) : (
          <Composer sessionId={session.id} working={session.status === "working" || session.status === "waiting"} disabled={ended || paused} paused={paused} />
        )}
      </div>
    </div>
  )
}
