import { useMemo } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Spinner } from "@/components/ui/spinner"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceLine, TraceTitle } from "@/components/ui/trace"
import { cn } from "@/lib/utils"
import type { Command, MessageRow } from "@/lib/types"
import { toolResults } from "@/lib/tools"
import { ToolCard } from "./ToolCard"


type Item =
  | { kind: "user"; key: string; text: string }
  | { kind: "command"; key: string; name: string; args: string }
  | { kind: "output"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "tool"; key: string; id: string; name: string; input: Record<string, unknown> }
  | { kind: "divider"; key: string; text: string }

const tag = (text: string, name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]

function toItems(messages: MessageRow[]): Item[] {
  const items: Item[] = []
  for (const m of messages) {
    const d = m.data
    if (d.isSidechain) continue
    if (d.type === "system" && d.subtype === "compact_boundary") {
      items.push({ kind: "divider", key: m.uuid, text: "Conversation compacted" })
      continue
    }
    // Slash commands Claude runs itself (/usage, /model, /status...) and
    // what they printed.
    if (d.type === "system" && d.subtype === "local_command" && typeof d.content === "string") {
      const name = tag(d.content, "command-name")
      const stdout = tag(d.content, "local-command-stdout")?.trim()
      if (name) items.push({ kind: "command", key: m.uuid, name, args: tag(d.content, "command-args") ?? "" })
      else if (stdout) items.push({ kind: "output", key: m.uuid, text: stdout })
      continue
    }
    if (!d.message) continue
    const content = d.message.content
    if (d.type === "user") {
      const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content
      blocks.forEach((b, i) => {
        if (b.type !== "text") return
        const key = `${m.uuid}:${i}`
        const name = tag(b.text, "command-name")
        const stdout = tag(b.text, "local-command-stdout")
        const bash = tag(b.text, "bash-input")
        const bashOut = tag(b.text, "bash-stdout")
        if (name) items.push({ kind: "command", key, name, args: tag(b.text, "command-args") ?? "" })
        else if (bash) items.push({ kind: "command", key, name: "!", args: bash })
        else if (stdout !== undefined || bashOut !== undefined) {
          const text = (stdout ?? bashOut ?? "").trim()
          if (text) items.push({ kind: "output", key, text })
        } else if (!d.isMeta && !b.text.startsWith("<")) items.push({ kind: "user", key, text: b.text })
      })
    } else if (d.type === "assistant" && Array.isArray(content)) {
      content.forEach((b, i) => {
        const key = `${m.uuid}:${i}`
        if (b.type === "text" && b.text.trim()) items.push({ kind: "assistant", key, text: b.text })
        else if (b.type === "thinking" && b.thinking.trim()) items.push({ kind: "thinking", key, text: b.thinking })
        else if (b.type === "tool_use") items.push({ kind: "tool", key, id: b.id, name: b.name, input: b.input })
      })
    }
  }
  return items
}

function Prose({ text }: { text: string }) {
  return (
    <div className="prose-chat max-w-[610px] text-body [&_a]:underline [&_code]:font-mono [&_code]:text-[0.9em] [&_li]:my-s1 [&_ol]:my-s3 [&_ol]:list-decimal [&_ol]:pl-s5 [&_p]:my-s3 [&_pre]:my-s3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:p-s4 [&_pre]:text-sm [&_table]:my-s3 [&_table]:text-sm [&_td]:border-b [&_td]:px-s3 [&_td]:py-s2 [&_th]:border-b [&_th]:px-s3 [&_th]:py-s2 [&_th]:text-left [&_ul]:my-s3 [&_ul]:list-disc [&_ul]:pl-s5 [&_h1]:my-s4 [&_h1]:font-medium [&_h2]:my-s4 [&_h2]:font-medium [&_h3]:my-s3 [&_h3]:font-medium">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  )
}

type Sent = Command & { created_at: string }

/**
 * What the person sent that the transcript doesn't show yet, so it appears
 * the moment it's sent. Some things never reach the transcript (a /cost
 * panel closed with Esc), so an echo also goes once the conversation has
 * moved past it.
 */
function unechoed(sent: Sent[], items: Item[], messages: MessageRow[]) {
  const said = new Set(
    items.flatMap((i) => (i.kind === "user" ? [i.text.trim()] : i.kind === "command" ? [`${i.name} ${i.args}`.trim()] : [])),
  )
  const latest = messages.reduce((t, m) => (m.ts && m.ts > t ? m.ts : t), "")
  return sent.filter((c) => {
    const text = String(c.payload.text ?? "").trim()
    return !said.has(text) && (!latest || new Date(c.created_at) > new Date(latest))
  })
}

/** Something the person typed, on the right. */
function Said({ children, mono, footer }: { children: React.ReactNode; mono?: boolean; footer?: React.ReactNode }) {
  return (
    <Message align="end" className="text-body">
      <MessageContent>
        <Bubble variant="secondary" align="end" className="max-w-[85%]">
          <BubbleContent className={cn("text-body whitespace-pre-wrap", mono && "font-mono text-sm")}>{children}</BubbleContent>
        </Bubble>
        {footer}
      </MessageContent>
    </Message>
  )
}

function Row({ item, results, cwd }: { item: Item; results: ReturnType<typeof toolResults>; cwd?: string }) {
  switch (item.kind) {
    case "user":
      return <Said>{item.text}</Said>
    case "command":
      return <Said mono>{item.name === "!" ? `! ${item.args}` : `${item.name} ${item.args}`.trim()}</Said>
    case "output":
      return (
        <pre className="max-h-80 overflow-auto rounded-md border px-s4 py-s3 font-mono text-sm whitespace-pre-wrap text-muted-foreground">{item.text}</pre>
      )
    case "assistant":
      return (
        <Message className="text-body">
          <MessageContent>
            <Prose text={item.text} />
          </MessageContent>
        </Message>
      )
    case "thinking":
      return (
        <Trace>
          <TraceCollapsible>
            <TraceCollapsibleTrigger>
              <TraceLine>
                <TraceTitle className="label">Thinking</TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent className="text-sm whitespace-pre-wrap">{item.text}</TraceCollapsibleContent>
          </TraceCollapsible>
        </Trace>
      )
    case "tool":
      return <ToolCard name={item.name} input={item.input} result={results.get(item.id)} cwd={cwd} />
    case "divider":
      return (
        <Marker variant="separator" className="label">
          <MarkerContent>{item.text}</MarkerContent>
        </Marker>
      )
  }
}

export function ChatView({ messages, sent = [], working, loading, cwd }: { messages: MessageRow[]; sent?: Sent[]; working: boolean; loading: boolean; cwd?: string }) {
  const items = useMemo(() => toItems(messages), [messages])
  const pending = useMemo(() => unechoed(sent, items, messages), [sent, items, messages])
  const results = useMemo(() => toolResults(messages), [messages])

  if (!items.length && !pending.length && !working) {
    return (
      <Empty>
        <EmptyHeader>
          {loading && <Spinner />}
          <EmptyTitle className="font-normal text-muted-foreground">{loading ? "Loading…" : "No messages yet. Send one below."}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }

  // Follows new messages unless the person has scrolled up to read.
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller>
        <MessageScrollerViewport aria-label="Conversation">
          <MessageScrollerContent className="gap-s4 py-s5" data-testid="chat">
            {items.map((item) => (
              <MessageScrollerItem key={item.key} messageId={item.key} data-kind={item.kind}>
                <Row item={item} results={results} cwd={cwd} />
              </MessageScrollerItem>
            ))}
            {pending.map((c) => (
              <MessageScrollerItem key={`sent-${c.id}`} messageId={`sent-${c.id}`} data-kind="sent" data-testid="sent">
                <Said
                  footer={
                    <MessageFooter className={cn("label normal-case", c.status === "failed" && "text-destructive")}>
                      {c.status === "pending" ? "Sending…" : c.status === "failed" ? `Failed: ${c.error}` : "Sent"}
                    </MessageFooter>
                  }
                >
                  {String(c.payload.text)}
                  {Array.isArray(c.payload.images) && c.payload.images.length > 0 && (
                    <span className="label block pt-s2 normal-case">{c.payload.images.length} image{c.payload.images.length > 1 ? "s" : ""} attached</span>
                  )}
                </Said>
              </MessageScrollerItem>
            ))}
            {working && (
              <MessageScrollerItem messageId="working">
                <Marker className="label" data-testid="working">
                  <MarkerIcon>
                    <Spinner className="text-highlight" />
                  </MarkerIcon>
                  <MarkerContent>Working</MarkerContent>
                </Marker>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
