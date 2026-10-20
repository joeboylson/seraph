import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemContent, ItemTitle } from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { sendKeys } from "@/lib/commands"
import type { Prompt } from "@/lib/screen"
import type { TerminalMirror } from "@/lib/terminal"
import type { HookEvent } from "@/lib/types"
import { shortPath } from "@/lib/tools"
import { ToolDetails } from "./ToolCard"


/**
 * A menu Claude is showing in its terminal: a permission prompt, a question,
 * plan approval, a picker. Each button presses that option's number.
 */
// Claude ignores keys for a moment after showing a menu, so a fast tap
// would be lost. Wait this long before enabling the buttons.
const SETTLE_MS = 1200
// If the menu is still up this long after a tap, the key didn't land.
const RETRY_MS = 3000

/** Changes when Claude shows a different menu. */
export const promptKey = (p: Prompt) => `${p.title}|${p.choices.map((c) => c.label).join("|")}|${p.body?.[0] ?? ""}`

export function PromptCard({
  prompt,
  sessionId,
  permission,
  mirror,
  cwd,
}: {
  prompt: Prompt
  sessionId: string
  permission?: HookEvent
  mirror: TerminalMirror
  cwd?: string
}) {
  const toolName = permission?.payload.tool_name
  const toolInput = permission?.payload.tool_input
  const path = typeof toolInput?.file_path === "string" ? toolInput.file_path : undefined
  const [state, setState] = useState<"settling" | "ready" | "sent" | "retry">("settling")
  const [sentAt, setSentAt] = useState(0)

  useEffect(() => {
    if (state === "settling") {
      const t = setTimeout(() => setState("ready"), SETTLE_MS)
      return () => clearTimeout(t)
    }
    if (state === "sent") {
      // Only offer a retry once fresh output shows the menu is still there.
      // If the screen copy is lagging, a second tap could land after the menu
      // has closed and type a stray character into Claude's input.
      const t = setInterval(() => {
        if (Date.now() - sentAt < RETRY_MS) return
        if (mirror.lastOutputAt > sentAt) setState("retry")
        else mirror.requestReplay()
      }, 1000)
      return () => clearInterval(t)
    }
  }, [state, sentAt, mirror])

  const press = (keys: string[]) => {
    setState("sent")
    setSentAt(Date.now())
    sendKeys(sessionId, keys).catch(() => setState("retry"))
  }
  const disabled = state === "settling" || state === "sent"
  return (
    // Capped so the choices stay on screen; the card scrolls inside itself.
    <Card role="region" className="max-h-[70dvh] min-h-0 shrink overflow-auto text-body ring-highlight" data-testid="prompt-card" aria-label="Claude is asking">
      <CardHeader>
        <CardDescription className="label">{prompt.choices.length ? "Claude is asking" : "Claude is showing"}</CardDescription>
        {prompt.title && <CardTitle className="text-body font-medium">{prompt.title}</CardTitle>}
      </CardHeader>
      <CardContent className="flex flex-col gap-s4">
        {toolName && toolInput && (
          <Item variant="outline" className="flex-col items-stretch" data-testid="prompt-tool">
            <ItemContent>
              <ItemTitle className="font-mono">
                {toolName}
                {path && <span className="font-normal text-muted-foreground">{shortPath(path, cwd)}</span>}
              </ItemTitle>
            </ItemContent>
            <ToolDetails name={toolName} input={toolInput} cwd={cwd} />
          </Item>
        )}
        {prompt.body && (
          <pre className="max-h-72 overflow-auto rounded-md border px-s4 py-s3 font-mono text-sm whitespace-pre-wrap" data-testid="prompt-body">
            {prompt.body.join("\n")}
          </pre>
        )}
        <div className="flex flex-col gap-s3">
          {prompt.choices.map((c) => (
            <Button
              key={c.key}
              variant={c.key === "1" ? "default" : "outline"}
              className="h-auto justify-start rounded-lg px-s4 py-s3 text-left whitespace-normal"
              onClick={() => press(c.keys)}
              disabled={disabled}
              data-testid="prompt-choice"
            >
              <Kbd>{c.key}</Kbd>
              <span>{c.label}</span>
            </Button>
          ))}
          <Button
            variant={prompt.choices.length ? "ghost" : "default"}
            className="w-fit rounded-full"
            disabled={disabled}
            onClick={() => press(["Escape"])}
            data-testid="prompt-escape"
          >
            {prompt.choices.length ? "Cancel" : "Close"} <Kbd>Esc</Kbd>
          </Button>
        </div>
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground" data-testid="prompt-state" data-state={state}>
          {state === "sent" ? "Sent…" : state === "retry" ? "That didn't go through. Try again." : prompt.hint}
        </p>
      </CardFooter>
    </Card>
  )
}
