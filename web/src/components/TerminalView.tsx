import { useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { sendKeys, type KeyName } from "@/lib/commands"
import type { TerminalMirror } from "@/lib/terminal"

const KEY_BAR: { label: string; keys: KeyName[] }[] = [
  { label: "Esc", keys: ["Escape"] },
  { label: "Enter", keys: ["Enter"] },
  { label: "↑", keys: ["Up"] },
  { label: "↓", keys: ["Down"] },
  { label: "Tab", keys: ["Tab"] },
  { label: "⇧Tab", keys: ["ShiftTab"] },
  { label: "Ctrl-C", keys: ["CtrlC"] },
  { label: "Ctrl-O", keys: ["CtrlO"] },
]

/** The session's real terminal. Typing here types into Claude. */
export function TerminalView({ mirror, sessionId, readOnly }: { mirror: TerminalMirror; sessionId: string; readOnly: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    if (!mirror.term.element) mirror.term.open(el)
    else el.appendChild(mirror.term.element)
    mirror.term.options.disableStdin = readOnly
    const dark = document.documentElement.classList.contains("dark")
    mirror.term.options.theme = dark
      ? { background: "#282828", foreground: "#e4e4e4", cursor: "#fabd2f", selectionBackground: "#67552a" }
      : { background: "#f0f0f0", foreground: "#2a2a2a", cursor: "#b57614", selectionBackground: "#decbae" }

    // Scale the fixed-size terminal down to fit narrow screens.
    const fit = () => {
      const screen = mirror.term.element
      if (!screen || !frame.current) return
      screen.style.transform = ""
      const scale = Math.min(1, frame.current.clientWidth / screen.scrollWidth)
      screen.style.transformOrigin = "top left"
      screen.style.transform = `scale(${scale})`
      el.style.height = `${screen.scrollHeight * scale}px`
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(frame.current!)
    const off = mirror.onChange(fit)
    if (!readOnly) mirror.term.focus()
    return () => {
      observer.disconnect()
      off()
    }
  }, [mirror, readOnly])

  return (
    <div className="flex flex-col gap-s4 py-s5">
      <div ref={frame} className="overflow-hidden rounded-lg border p-s3" data-testid="terminal">
        <div ref={host} />
      </div>
      {!readOnly && (
        <div className="flex flex-wrap gap-s3" aria-label="Keys">
          {KEY_BAR.map((k) => (
            <Button key={k.label} variant="outline" size="sm" className="rounded-full font-mono" onClick={() => sendKeys(sessionId, k.keys)}>
              {k.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
