import { CheckIcon, CircleIcon, LoaderIcon } from "lucide-react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceLine, TraceTitle } from "@/components/ui/trace"
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { cn } from "@/lib/utils"
import { diffLines, edits, resultText, shortPath, type DiffLine, type Todo, type ToolResult } from "@/lib/tools"
type Input = Record<string, unknown>

const str = (input: Input, key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined)

export function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-sm border font-mono text-xs leading-relaxed" data-testid="diff">
      {lines.map((l, k) => (
        <div
          key={k}
          className={cn(
            "px-s3 whitespace-pre-wrap [overflow-wrap:anywhere]",
            l.op === "+" && "bg-success/15",
            l.op === "-" && "bg-destructive/12 text-destructive",
            l.op === " " && "text-muted-foreground",
          )}
        >
          <span className="select-none pr-s3 opacity-60">{l.op}</span>
          {l.text || " "}
        </div>
      ))}
    </pre>
  )
}

export function Todos({ todos }: { todos: Todo[] }) {
  return (
    <ItemGroup className="gap-0" data-testid="todos">
      {todos.map((t, k) => (
        <Item key={k} size="xs" className="px-0 py-s1">
          <ItemMedia>
            {t.status === "completed" ? (
              <CheckIcon className="size-4 text-success" aria-label="Done" />
            ) : t.status === "in_progress" ? (
              <LoaderIcon className="size-4 text-highlight" aria-label="In progress" />
            ) : (
              <CircleIcon className="size-4 text-muted-foreground" aria-label="To do" />
            )}
          </ItemMedia>
          <ItemContent>
            <ItemTitle className={cn("font-normal", t.status === "completed" && "text-muted-foreground line-through", t.status === "in_progress" && "font-medium")}>
              {t.content}
            </ItemTitle>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  )
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-s2">
      <p className="label">{label}</p>
      {children}
    </div>
  )
}

function Output({ text, error }: { text: string; error?: boolean }) {
  return (
    <pre className={cn("max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]", error && "text-destructive")}>{text || "(no output)"}</pre>
  )
}

/** One line saying what the call does, and a short note on the right of it. */
function describe(name: string, input: Input, cwd?: string): { summary: string; note?: string; isPath?: boolean } {
  const path = str(input, "file_path") ?? str(input, "notebook_path")
  if (name === "Edit" || name === "MultiEdit" || name === "Write") {
    let added = 0
    let removed = 0
    for (const e of edits(name, input))
      for (const l of diffLines(e.before, e.after)) {
        if (l.op === "+") added++
        else if (l.op === "-") removed++
      }
    return { summary: path ? shortPath(path, cwd) : "", note: `+${added} −${removed}`, isPath: true }
  }
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    const todos = input.todos as Todo[]
    const current = todos.find((t) => t.status === "in_progress")
    return { summary: current?.activeForm ?? current?.content ?? "Plan", note: `${todos.filter((t) => t.status === "completed").length}/${todos.length}` }
  }
  if (name === "Bash") return { summary: str(input, "description") ?? str(input, "command") ?? "" }
  if (path) return { summary: shortPath(path, cwd), isPath: true }
  return {
    summary:
      str(input, "pattern") ?? str(input, "url") ?? str(input, "query") ?? str(input, "description") ?? str(input, "prompt") ?? str(input, "command") ?? "",
  }
}

export function ToolDetails({ name, input, result, cwd }: { name: string; input: Input; result?: ToolResult; cwd?: string }) {
  const output = resultText(result)
  const diffs = edits(name, input)
  if (diffs.length) {
    return (
      <div className="flex flex-col gap-s3">
        {diffs.map((e, k) => (
          <Diff key={k} lines={diffLines(e.before, e.after)} />
        ))}
        {result?.is_error && <Output text={output} error />}
      </div>
    )
  }
  if (name === "TodoWrite" && Array.isArray(input.todos)) return <Todos todos={input.todos as Todo[]} />
  if (name === "Bash") {
    return (
      <div className="flex flex-col gap-s3">
        <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
          <span className="select-none text-muted-foreground">$ </span>
          {str(input, "command")}
        </pre>
        {result && <Output text={output} error={result.is_error} />}
      </div>
    )
  }
  if (name === "Task" || name === "Agent") {
    return (
      <div className="flex flex-col gap-s3">
        {str(input, "subagent_type") && <p className="label">{str(input, "subagent_type")}</p>}
        <TraceCollapsible>
          <TraceCollapsibleTrigger>
            <TraceLine>
              <TraceTitle className="label">Instructions</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="text-sm whitespace-pre-wrap">{str(input, "prompt")}</TraceCollapsibleContent>
        </TraceCollapsible>
        {result && (
          <div className={cn("text-sm", result.is_error && "text-destructive")} data-testid="agent-report">
            <Markdown remarkPlugins={[remarkGfm]}>{output || "(no report)"}</Markdown>
          </div>
        )}
      </div>
    )
  }
  if (name === "Read") {
    const path = str(input, "file_path")
    return <Block label="Read">{<p className="font-mono text-xs [overflow-wrap:anywhere]">{path && shortPath(path, cwd)}</p>}</Block>
  }
  return (
    <div className="flex flex-col gap-s3">
      <Block label="Input">
        <pre className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(input, null, 2)}</pre>
      </Block>
      {result && (
        <Block label="Output">
          <Output text={output} error={result.is_error} />
        </Block>
      )}
    </div>
  )
}

export function ToolCard({ name, input, result, cwd }: { name: string; input: Input; result?: ToolResult; cwd?: string }) {
  const { summary, note, isPath } = describe(name, input, cwd)
  const status = !result ? "running" : result.is_error ? "error" : undefined
  return (
    <Trace data-testid="tool-card" data-tool={name}>
      <TraceCollapsible>
        <TraceCollapsibleTrigger className="w-full">
          <TraceLine status={status} className="min-w-0 flex-1 font-mono">
            <span className="shrink-0 font-medium text-foreground">{name}</span>
            {/* Paths are cut from the left, so the file name stays visible. */}
            <TraceTitle className={cn("flex-1", isPath && "[direction:rtl]")}>
              <bdi>{summary}</bdi>
            </TraceTitle>
            {note && <TraceDescription className="text-xs">{note}</TraceDescription>}
            <TraceDescription className="label normal-case">{status ?? "done"}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="text-foreground">
          <ToolDetails name={name} input={input} result={result} cwd={cwd} />
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}
