import type { ContentBlock, MessageRow } from "@/lib/types"

export type ToolResult = Extract<ContentBlock, { type: "tool_result" }>

/** A path inside the session's folder, shown relative to it. */
export function shortPath(path: string, cwd?: string) {
  if (cwd && path.startsWith(cwd.replace(/\/$/, "") + "/")) return path.slice(cwd.replace(/\/$/, "").length + 1)
  return path.replace(/^\/(Users|home)\/[^/]+/, "~")
}

export function resultText(result: ToolResult | undefined) {
  if (!result) return ""
  const c = result.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === "object" && "text" in b ? String(b.text) : "")).join("\n")
  return JSON.stringify(c, null, 2)
}

export type DiffLine = { op: " " | "-" | "+"; text: string }

/** Line diff by longest common subsequence. Edits are small, so O(n·m) is fine. */
export function diffLines(before: string, after: string): DiffLine[] {
  // An empty side has no lines, not one empty line (a new file adds, never removes).
  const a = before ? before.split("\n") : []
  const b = after ? after.split("\n") : []
  if (a.length * b.length > 250_000) return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i++] })
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "-", text: a[i++] })
    else out.push({ op: "+", text: b[j++] })
  }
  while (i < a.length) out.push({ op: "-", text: a[i++] })
  while (j < b.length) out.push({ op: "+", text: b[j++] })
  return out
}

export type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }

/** Claude's current todo list: the input of its latest TodoWrite call. */
export function latestTodos(messages: MessageRow[]): Todo[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const d = messages[i].data
    if (d.isSidechain || d.type !== "assistant" || !Array.isArray(d.message?.content)) continue
    for (const b of [...d.message.content].reverse())
      if (b.type === "tool_use" && b.name === "TodoWrite" && Array.isArray(b.input.todos)) return b.input.todos as Todo[]
  }
  return null
}

/** Tokens in the context window as of Claude's latest reply. */
export function contextTokens(messages: MessageRow[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const d = messages[i].data
    if (d.isSidechain) continue
    if (d.type === "system" && d.subtype === "compact_boundary") return null
    const u = d.type === "assistant" ? d.message?.usage : undefined
    if (u) return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  }
  return null
}

const str = (input: Record<string, unknown>, key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined)

/** The before and after text of each change an editing tool call makes. */
export function edits(name: string, input: Record<string, unknown>): { before: string; after: string }[] {
  if (name === "Edit") return [{ before: str(input, "old_string") ?? "", after: str(input, "new_string") ?? "" }]
  if (name === "MultiEdit" && Array.isArray(input.edits))
    return (input.edits as Record<string, unknown>[]).map((e) => ({ before: str(e, "old_string") ?? "", after: str(e, "new_string") ?? "" }))
  if (name === "Write") return [{ before: "", after: str(input, "content") ?? "" }]
  return []
}

/** Each tool call's result, by tool call id. */
export function toolResults(messages: MessageRow[]) {
  const results = new Map<string, ToolResult>()
  for (const m of messages) {
    const content = m.data.message?.content
    if (m.data.type !== "user" || !Array.isArray(content)) continue
    for (const b of content) if (b.type === "tool_result") results.set(b.tool_use_id, b)
  }
  return results
}

export type FileChange = { path: string; changes: { before: string; after: string; tool: string }[]; added: number; removed: number }

/** Every file Claude edited or wrote in these messages, in the order first touched. Failed edits are left out. */
export function fileChanges(messages: MessageRow[]): FileChange[] {
  const results = toolResults(messages)
  const files = new Map<string, FileChange>()
  for (const m of messages) {
    const content = m.data.message?.content
    if (m.data.isSidechain || m.data.type !== "assistant" || !Array.isArray(content)) continue
    for (const b of content) {
      if (b.type !== "tool_use") continue
      const path = str(b.input, "file_path")
      const result = results.get(b.id)
      if (!path || !result || result.is_error) continue
      const changes = edits(b.name, b.input)
      if (!changes.length) continue
      const file = files.get(path) ?? { path, changes: [], added: 0, removed: 0 }
      for (const c of changes) {
        file.changes.push({ ...c, tool: b.name })
        for (const l of diffLines(c.before, c.after)) {
          if (l.op === "+") file.added++
          else if (l.op === "-") file.removed++
        }
      }
      files.set(path, file)
    }
  }
  return [...files.values()]
}
