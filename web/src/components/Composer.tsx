import { ImageIcon, SendIcon, SquareIcon, XIcon } from "lucide-react"
import { useLayoutEffect, useRef, useState } from "react"
import { Attachment, AttachmentAction, AttachmentActions, AttachmentGroup, AttachmentMedia } from "@/components/ui/attachment"
import { Command, CommandItem, CommandList } from "@/components/ui/command"
import { FieldError } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
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

type Image = { name: string; type: string; data: string; url: string }

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_HEIGHT = 233

// Phone keyboards have no Shift+Enter, so there Enter adds a line and the button sends.
const touch = () => window.matchMedia("(pointer: coarse)").matches

function readImage(file: File): Promise<Image> {
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

export function Composer({ sessionId, working, disabled, paused }: { sessionId: string; working: boolean; disabled: boolean; paused?: boolean }) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [images, setImages] = useState<Image[]>([])
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
        <Command shouldFilter={false} className="absolute bottom-full mb-s3 h-auto w-full rounded-lg border">
          <CommandList label="Commands">
            {matches.map(([name, help]) => (
              <CommandItem key={name} value={name} onSelect={() => send(name)} className="gap-s4">
                <span className="font-mono">{name}</span>
                <span className="text-muted-foreground">{help}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      )}
      {images.length > 0 && (
        <AttachmentGroup aria-label="Attached images">
          {images.map((image, i) => (
            <Attachment key={i} size="xs">
              <AttachmentMedia variant="image">
                <img src={image.url} alt={image.name} />
              </AttachmentMedia>
              <AttachmentActions>
                <AttachmentAction onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove ${image.name}`}>
                  <XIcon />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          ))}
        </AttachmentGroup>
      )}
      {imageError && <FieldError>{imageError}</FieldError>}
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
      <InputGroup className="rounded-2xl">
        <InputGroupTextarea
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
          placeholder={paused ? "Paused. Resume to carry on." : disabled ? "This session has ended" : "Message Claude, / for commands"}
          disabled={disabled}
          rows={1}
          className="min-h-10 px-s4 py-s3 text-body placeholder:truncate"
          aria-label="Message"
          data-testid="composer"
        />
        <InputGroupAddon align="block-end">
          <InputGroupButton size="icon-sm" className="rounded-full" disabled={disabled} onClick={() => fileInput.current?.click()} aria-label="Attach image" title="Attach image">
            <ImageIcon />
          </InputGroupButton>
          {working && (
            <InputGroupButton
              variant="outline"
              size="icon-sm"
              className="ml-auto rounded-full"
              onClick={() => sendCommand(sessionId, "interrupt")}
              aria-label="Stop Claude (Esc)"
              title="Stop Claude (Esc)"
              data-testid="interrupt"
            >
              <SquareIcon />
            </InputGroupButton>
          )}
          <InputGroupButton
            type="submit"
            variant="default"
            size="icon-sm"
            className={working ? "rounded-full" : "ml-auto rounded-full"}
            disabled={disabled || sending || (!text.trim() && !images.length)}
            aria-label="Send"
            title="Send (Enter)"
            data-testid="send"
          >
            <SendIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}
