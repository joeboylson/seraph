import { ChevronRightIcon, PencilIcon, PowerIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useMessages, useSentPrompts, useSessionEvents } from "@/hooks/data"
import { askDaemon, deleteSession, renameSession, sendCommand, sendKeys } from "@/lib/commands"
import { readMode, readPrompt, type Prompt } from "@/lib/screen"
import { getMirror } from "@/lib/terminal"
import { contextTokens, fileChanges, latestTodos, shortPath, type Todo } from "@/lib/tools"
import type { Session } from "@/lib/types"
import { ChangesView } from "./ChangesView"
import { ChatView } from "./ChatView"
import { Composer } from "./Composer"
import { PromptCard, promptKey } from "./PromptCard"
import { sessionTitle } from "./SessionList"
import { StatusBadge } from "./StatusBadge"
import { TerminalView } from "./TerminalView"
import { Todos } from "./ToolCard"

const MODE_LABELS: Record<string, string> = {
  default: "Ask before edits",
  acceptEdits: "Accept edits",
  plan: "Plan mode",
  auto: "Auto",
  bypassPermissions: "Bypass permissions",
  dontAsk: "Don't ask",
}

const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

/** Claude's todo list, folded to one line above the message box. */
function PlanBar({ todos }: { todos: Todo[] }) {
  const current = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending")
  const done = todos.filter((t) => t.status === "completed").length
  return (
    <Collapsible className="rounded-md border" data-testid="plan">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-s3 px-s4 py-s2 text-left text-sm">
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-[144ms] group-data-[state=open]:rotate-90" />
        <span className="min-w-0 flex-1 truncate">{current?.status === "in_progress" ? current.activeForm ?? current.content : current?.content}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {done}/{todos.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="max-h-[40dvh] overflow-auto border-t px-s4 py-s3">
        <Todos todos={todos} />
      </CollapsibleContent>
    </Collapsible>
  )
}

export function SessionView({ session, onOpen, onDeleted }: { session: Session; onOpen: (id: string) => void; onDeleted: () => void }) {
  const ended = session.status === "ended"
  // A linked session is followed through its transcript only: there's no
  // terminal to mirror or type into.
  const linked = session.mode === "linked"
  const { messages, loading } = useMessages(session.id)
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

  async function resume() {
    setResuming(true)
    try {
      // On the computer the session ran on: that's where its folder and history are.
      const { session_id } = await askDaemon<{ session_id: string }>(
        "start_session",
        { cwd: session.cwd, resume: session.claude_session_id, name: session.name },
        session.hostname ?? "",
      )
      onOpen(session_id)
    } finally {
      setResuming(false)
    }
  }

  const todos = useMemo(() => latestTodos(messages), [messages])
  const context = useMemo(() => contextTokens(messages), [messages])
  const changes = useMemo(() => fileChanges(messages), [messages])
  const origin = session.mode === "headless" ? "Started from web" : linked ? "Linked, read-only" : `Terminal on ${session.hostname ?? "this Mac"}`

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex min-w-0 flex-col gap-s1 border-b pb-s4">
        <div className="flex min-w-0 items-center gap-s4">
          <h1 className="min-w-0 truncate text-title font-medium tracking-[-0.03em]" data-testid="session-title">{sessionTitle(session)}</h1>
          <Button
            variant="ghost"
            size="icon-sm"
            className="-ml-s3 shrink-0 text-muted-foreground"
            onClick={() => {
              const name = window.prompt("Rename session", session.name ?? sessionTitle(session))
              if (name !== null) renameSession(session.id, name).catch(() => {})
            }}
            aria-label="Rename session"
            title="Rename"
            data-testid="rename"
          >
            <PencilIcon />
          </Button>
          <StatusBadge status={session.status} className="shrink-0" />
        </div>
        {/* Cut from the left so the project folder stays visible. */}
        <p className="truncate text-left font-mono text-sm text-muted-foreground [direction:rtl]" title={session.cwd}>
          <bdi>{shortPath(session.cwd)}</bdi>
        </p>
        <p className="label" data-testid="session-meta">
          {session.model && !ended && !linked ? (
            <button type="button" className="uppercase underline decoration-dotted underline-offset-4" onClick={() => sendCommand(session.id, "prompt", { text: "/model" })} title="Change model" data-testid="model">
              {session.model}
            </button>
          ) : (
            session.model
          )}
          {session.model && " · "}
          {[context ? `${formatTokens(context)} context` : null, origin].filter(Boolean).join(" · ")}
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="flex-1 gap-0">
        <div className="flex flex-wrap items-center justify-between gap-s3 pt-s4">
          <TabsList className="w-fit">
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="changes" data-testid="changes-tab">
              Changes{changes.length > 0 && <span className="font-mono text-xs text-muted-foreground">{changes.length}</span>}
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
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  onClick={() => confirm("End this session?") && sendCommand(session.id, "kill")}
                  aria-label="End session"
                  title="End session"
                  data-testid="end-session"
                >
                  <PowerIcon /> <span className="hidden sm:inline">End</span>
                </Button>
              </>
            )}
            {ended && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => confirm("Delete this session and its conversation from Supabase? The files Claude changed stay as they are.") && deleteSession(session.id).then(onDeleted, () => {})}
                aria-label="Delete session"
                title="Delete session"
                data-testid="delete-session"
              >
                <Trash2Icon />
              </Button>
            )}
            {ended && session.claude_session_id && (
              <Button size="sm" className="rounded-full" onClick={resume} disabled={resuming} data-testid="resume">
                <RotateCcwIcon /> {resuming ? "Resuming…" : "Resume"}
              </Button>
            )}
          </div>
        </div>
        <TabsContent value="chat">
          <ChatView messages={messages} sent={sent} working={session.status === "working"} loading={loading} cwd={session.cwd} />
        </TabsContent>
        <TabsContent value="changes">
          <ChangesView files={changes} cwd={session.cwd} />
        </TabsContent>
        <TabsContent value="terminal">
          {mirror && <TerminalView mirror={mirror} sessionId={session.id} readOnly={ended} />}
        </TabsContent>
      </Tabs>

      <div className="sticky bottom-0 flex flex-col gap-s3 border-t bg-background pt-s3 pb-[max(var(--spacing-s4),env(safe-area-inset-bottom))]">
        {todos && !ended && !prompt && todos.some((t) => t.status !== "completed") && tab === "chat" && <PlanBar todos={todos} />}
        {prompt && mirror && tab === "chat" && (
          <PromptCard key={promptKey(prompt)} prompt={prompt} sessionId={session.id} permission={permission} mirror={mirror} cwd={session.cwd} />
        )}
        {!prompt && session.status === "waiting" && tab === "chat" && mirror && (
          <p className="text-sm text-muted-foreground" data-testid="waiting-hint">
            Claude is waiting on you.{" "}
            <button type="button" className="underline underline-offset-4" onClick={() => setTab("terminal")}>Open the terminal</button>{" "}
            to answer.
          </p>
        )}
        {linked && !ended ? (
          <p className="text-sm text-muted-foreground" data-testid="linked-note">
            Read-only. To control this session from here, exit it and run{" "}
            <code className="font-mono">seraph resume {session.claude_session_id?.slice(0, 8)}</code>
          </p>
        ) : (
          <Composer sessionId={session.id} working={session.status === "working" || session.status === "waiting"} disabled={ended} />
        )}
      </div>
    </div>
  )
}
