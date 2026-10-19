import { ImageIcon, SendIcon, SquareIcon, XIcon } from "lucide-react"
import { useLayoutEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { sendCommand } from "@/lib/commands"

// Shown when the message starts with "/". Anything else typed is sent as is,
// so custom commands and skills work too.
const SLASH_COMMANDS = [
  ["/clear", "Start a fresh conversation"],
  ["/compact", "Summarize the conversation to free up context"],
  ["/context", "Show context usage"],
  ["/usage", "Show plan usage limits"],
  ["/cost", "Show token usage and cost"],
  ["/model", "Change the model"],
  ["/init", "Write a CLAUDE.md for this project"],
  ["/review", "Review a pull request"],
  ["/memory", "Edit memory files"],
  ["/agents", "Manage subagents"],
  ["/mcp", "Manage MCP servers"],
  ["/permissions", "Manage tool permissions"],
  ["/hooks", "Manage hooks"],
  ["/add-dir", "Let Claude work in another folder"],
  ["/todos", "Show the todo list"],
  ["/export", "Export the conversation"],
  ["/config", "Open settings"],
  ["/doctor", "Check the Claude Code install"],
  ["/status", "Show version, model, and account"],
  ["/resume", "Resume an earlier conversation"],
  ["/rewind", "Rewind the conversation or code"],
  ["/help", "List commands"],
] as const

type Attachment = { name: string; type: string; data: string; url: string }

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_HEIGHT = 233

// Phone keyboards have no Shift+Enter, so there Enter adds a line and the button sends.
const touch = () => window.matchMedia("(pointer: coarse)").matches

function readImage(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve({ name: file.name, type: file.type, data: url.slice(url.indexOf(",") + 1), url })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function Composer({ sessionId, working, disabled }: { sessionId: string; working: boolean; disabled: boolean }) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [images, setImages] = useState<Attachment[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  // Grow with the text, up to a limit, then scroll.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight + 2, MAX_HEIGHT)}px`
  }, [text])

  async function addImages(files: Iterable<File>) {
    setImageError(null)
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue
      if (file.size > MAX_IMAGE_BYTES) {
        setImageError(`${file.name} is over 5 MB`)
        continue
      }
      const image = await readImage(file)
      setImages((prev) => [...prev, image])
    }
  }
  const matches = text.startsWith("/") && !text.includes(" ")
    ? SLASH_COMMANDS.filter(([name]) => name.startsWith(text.toLowerCase()))
    : []

  async function send(value = text) {
    const message = value.trim() || (images.length ? "Take a look at this." : "")
    if (!message || sending) return
    setSending(true)
    try {
      await sendCommand(sessionId, "prompt", {
        text: message,
        ...(images.length && { images: images.map(({ name, type, data }) => ({ name, type, data })) }),
      })
      setText("")
      setImages([])
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      className="relative flex flex-col gap-s3"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      {matches.length > 0 && (
        <ul className="absolute bottom-full mb-s3 max-h-72 w-full overflow-auto rounded-lg border bg-popover py-s2" role="listbox" aria-label="Commands">
          {matches.map(([name, help]) => (
            <li key={name}>
              <button
                type="button"
                className="flex w-full gap-s4 px-s4 py-s2 text-left text-sm hover:bg-accent"
                onClick={() => send(name)}
              >
                <span className="font-mono">{name}</span>
                <span className="text-muted-foreground">{help}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-s3" aria-label="Attached images">
          {images.map((image, i) => (
            <li key={i} className="relative">
              <img src={image.url} alt={image.name} className="size-[55px] rounded-md border object-cover" />
              <button
                type="button"
                className="absolute -top-s2 -right-s2 rounded-full border bg-background p-s1"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                aria-label={`Remove ${image.name}`}
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {imageError && <p className="text-sm text-destructive">{imageError}</p>}
      <div className="flex items-end gap-s2">
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            addImages(e.target.files ?? [])
            e.target.value = ""
          }}
          data-testid="image-input"
        />
        <Button type="button" variant="ghost" size="icon" className="mb-0.5 shrink-0 rounded-full" disabled={disabled} onClick={() => fileInput.current?.click()} aria-label="Attach image" title="Attach image">
          <ImageIcon />
        </Button>
        <Textarea
          ref={box}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.some((f) => f.type.startsWith("image/"))) {
              e.preventDefault()
              addImages(files)
            }
          }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touch()) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={disabled ? "This session has ended" : "Message Claude, / for commands"}
          disabled={disabled}
          rows={1}
          className="min-h-10 min-w-0 flex-1 resize-none placeholder:truncate rounded-2xl px-s4 py-s2 text-body"
          aria-label="Message"
          data-testid="composer"
        />
        {working && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="mb-0.5 shrink-0 rounded-full"
            onClick={() => sendCommand(sessionId, "interrupt")}
            aria-label="Stop Claude (Esc)"
            title="Stop Claude (Esc)"
            data-testid="interrupt"
          >
            <SquareIcon />
          </Button>
        )}
        <Button
          type="submit"
          size="icon"
          className="mb-0.5 shrink-0 rounded-full"
          disabled={disabled || sending || (!text.trim() && !images.length)}
          aria-label="Send"
          title="Send (Enter)"
          data-testid="send"
        >
          <SendIcon />
        </Button>
      </div>
    </form>
  )
}
