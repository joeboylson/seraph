import { Terminal } from "@xterm/xterm"
import { sendCommand } from "./commands"
import { db } from "./supabase"

// Device attributes, cursor position and focus reports, colour queries.
// eslint-disable-next-line no-control-regex
const TERMINAL_REPLIES = /\x1b\[[?>]?[\d;]*c|\x1b\[\d+;\d+R|\x1b\[[IO]|\x1b\][\d;]*rgb:[^\x07\x1b]*(\x07|\x1b\\)/g

/**
 * A copy of one session's terminal, fed by the wrapper's broadcast. It
 * lives outside React so switching tabs keeps the screen, and so the
 * choice reader can scan it while the terminal isn't on screen.
 */
export class TerminalMirror {
  readonly term: Terminal
  private listeners = new Set<() => void>()
  private channel: ReturnType<typeof db.channel>
  private pendingInput = ""
  private inputTimer: ReturnType<typeof setTimeout> | undefined
  connected = false
  /** When output last arrived from the session. */
  lastOutputAt = 0
  private lastSeq: number | null = null
  private replayAsked = 0
  readonly sessionId: string

  constructor(sessionId: string, cols: number, rows: number) {
    this.sessionId = sessionId
    this.term = new Terminal({
      cols,
      rows,
      scrollback: 5000,
      fontFamily: '"Geist Mono Variable", ui-monospace, Menlo, monospace',
      fontSize: 13,
      allowProposedApi: true,
      convertEol: false,
    })
    // Private: only signed-in members may listen (see the realtime.messages policy).
    this.channel = db.channel(`term:${sessionId}`, { config: { private: true } })
    this.channel
      .on("broadcast", { event: "reset" }, ({ payload }) => {
        this.term.reset()
        this.lastSeq = payload.seq
        if (payload.cols && payload.rows) this.term.resize(payload.cols, payload.rows)
      })
      .on("broadcast", { event: "out" }, ({ payload }) => {
        // Chunks are numbered; a gap means one went missing and the screen
        // is wrong, so ask for a fresh copy.
        if (this.lastSeq !== null && payload.seq !== this.lastSeq + 1) this.requestReplay()
        this.lastSeq = payload.seq
        const bytes = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0))
        this.lastOutputAt = Date.now()
        this.term.write(bytes, () => this.emit())
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          this.connected = true
          // Ask the wrapper to resend recent output so we start with a full screen.
          this.requestReplay()
          this.emit()
        }
      })

    // Output sent while a phone slept is lost; ask for the screen again on waking.
    document.addEventListener("visibilitychange", this.onVisible)

    // Keys typed into the web terminal go to the session in small batches.
    // xterm also answers Claude's terminal queries and reports focus changes
    // through onData; the real terminal already answers those, so drop them.
    this.term.onData((raw) => {
      const data = raw.replace(TERMINAL_REPLIES, "")
      if (!data) return
      this.pendingInput += data
      clearTimeout(this.inputTimer)
      this.inputTimer = setTimeout(() => {
        const data = this.pendingInput
        this.pendingInput = ""
        sendCommand(sessionId, "keys", { data }).catch(() => {})
      }, 30)
    })
  }

  /** Ask the wrapper to resend the screen (rate-limited). */
  requestReplay() {
    if (Date.now() - this.replayAsked < 3000) return
    this.replayAsked = Date.now()
    sendCommand(this.sessionId, "replay").catch(() => {})
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit() {
    for (const l of this.listeners) l()
  }

  /** The visible screen as plain text lines. */
  screenLines(): string[] {
    const buf = this.term.buffer.active
    const lines: string[] = []
    for (let i = buf.viewportY; i < buf.viewportY + this.term.rows; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "")
    }
    return lines
  }

  private onVisible = () => {
    if (document.visibilityState === "visible") this.requestReplay()
  }

  dispose() {
    document.removeEventListener("visibilitychange", this.onVisible)
    clearTimeout(this.inputTimer)
    db.removeChannel(this.channel)
    this.term.dispose()
  }
}

const mirrors = new Map<string, TerminalMirror>()

export function getMirror(sessionId: string, cols: number, rows: number) {
  let mirror = mirrors.get(sessionId)
  if (!mirror) {
    mirror = new TerminalMirror(sessionId, cols, rows)
    mirrors.set(sessionId, mirror)
  }
  return mirror
}

export function dropMirror(sessionId: string) {
  mirrors.get(sessionId)?.dispose()
  mirrors.delete(sessionId)
}
