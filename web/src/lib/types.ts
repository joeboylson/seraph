export type SessionStatus = "starting" | "idle" | "working" | "waiting" | "ended"

type UsageWindow = { used_percentage: number; resets_at: number | null }

/** What Claude's status line last reported: context and plan limits, in percent. */
export type SessionUsage = {
  context_percentage: number | null
  five_hour: UsageWindow | null
  seven_day: UsageWindow | null
}

export type Session = {
  id: string
  name: string | null
  cwd: string
  hostname: string | null
  mode: "wrapped" | "headless" | "linked"
  claude_session_id: string | null
  status: SessionStatus
  permission_mode: string | null
  model: string | null
  cols: number | null
  rows: number | null
  created_at: string
  updated_at: string
  ended_at: string | null
  usage: SessionUsage | null
  /** Set while the session is paused: Claude stopped, waiting to be resumed. */
  paused_at: string | null
  /** What it pushes about: everything, when it needs you or finishes a long task, or nothing. */
  notify?: Notify
}

export type Notify = "all" | "needs-you" | "off"

export type HookEvent = {
  id: number
  created_at: string
  session_id: string
  hook_event: string
  csc_session: string | null
  payload: Record<string, unknown> & {
    tool_name?: string
    tool_input?: Record<string, unknown>
    tool_use_id?: string
    message?: string
    notification_type?: string
  }
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: "image"; source: unknown }

// One line of Claude's transcript JSONL.
export type TranscriptEntry = {
  type: string
  uuid?: string
  isMeta?: boolean
  isSidechain?: boolean
  message?: {
    role: string
    content: string | ContentBlock[]
    model?: string
    usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number }
  }
  toolUseResult?: unknown
  [key: string]: unknown
}

export type MessageRow = {
  id: number
  session_id: string
  uuid: string
  type: string
  ts: string | null
  data: TranscriptEntry
}

export type Command = {
  id: number
  session_id: string | null
  kind: string
  payload: Record<string, unknown>
  status: "pending" | "done" | "failed"
  result: unknown
  error: string | null
  /** When the session took it: for a prompt, when it was typed into Claude. */
  done_at?: string | null
}

export type Controller = {
  id: string
  hostname: string
  home: string
  /** It checks in every 10 minutes while running. */
  last_seen: string
  /** Set when it stopped cleanly; empty while it runs. */
  stopped_at?: string | null
  version?: string | null
  /** What it reports about its computer on each check-in. */
  info?: { folders?: string[]; at_login?: boolean; platform?: string } | null
}

export type LogLine = { id: number; machine: string; source: string; ts: string | null; pid: number | null; line: string }
