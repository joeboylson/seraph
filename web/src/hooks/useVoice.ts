import { useCallback, useEffect, useRef, useState } from "react"
import type { MessageRow } from "@/lib/types"

// The browser's own speech recognition and speech: no service or keys.
// Chrome, Edge and Safari (iPhone too) have both; elsewhere the buttons hide.

type Recognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
}

function recognitionClass(): (new () => Recognition) | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

/**
 * Talk instead of type: while listening, what's said is written into the
 * message box after whatever was already there.
 */
export function useDictation(onText: (text: string) => void) {
  const supported = typeof window !== "undefined" && !!recognitionClass()
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<Recognition | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const stop = useCallback(() => rec.current?.stop(), [])

  const start = useCallback((before: string) => {
    const Rec = recognitionClass()
    if (!Rec) return
    setError(null)
    const r = new Rec()
    r.continuous = true
    r.interimResults = true
    r.lang = navigator.language
    const lead = before.trim() ? `${before.trimEnd()} ` : ""
    let finished = ""
    r.onresult = (e) => {
      let interim = ""
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const said = e.results[i][0].transcript
        if (e.results[i].isFinal) finished += said
        else interim += said
      }
      onTextRef.current(lead + (finished + interim).trimStart())
    }
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") setError(e.error === "not-allowed" ? "Allow the microphone to talk to Claude." : `Couldn't listen: ${e.error}`)
    }
    r.onend = () => {
      setListening(false)
      rec.current = null
    }
    rec.current = r
    r.start()
    setListening(true)
  }, [])

  useEffect(() => () => rec.current?.stop(), [])
  return { supported, listening, error, start, stop }
}

const READ_KEY = "seraph:read-aloud"

/** Markdown to something worth hearing: no symbols, code said as "code". */
export function speakable(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Read Claude's new replies aloud while switched on. Only replies that
 * arrive after it's switched on are read, each once. The setting is kept in
 * this browser.
 */
export function useReadAloud(messages: MessageRow[]) {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(READ_KEY) === "on"
    } catch {
      return false
    }
  })
  const spoken = useRef<Set<string> | null>(null)

  const toggle = useCallback((next: boolean) => {
    setOn(next)
    try {
      localStorage.setItem(READ_KEY, next ? "on" : "off")
    } catch {
      // only for this visit then
    }
    if (!next) window.speechSynthesis.cancel()
    // Phones only speak after a tap has spoken once; this is that tap.
    else window.speechSynthesis.speak(new SpeechSynthesisUtterance(""))
  }, [])

  useEffect(() => {
    if (!supported) return
    const replies = messages.filter((m) => m.type === "assistant")
    // What's already there when it's switched on (or the page opens) isn't read.
    if (!on || !spoken.current) {
      spoken.current = new Set(replies.map((m) => m.uuid))
      return
    }
    for (const m of replies) {
      if (spoken.current.has(m.uuid)) continue
      spoken.current.add(m.uuid)
      const content = m.data.message?.content
      const text = Array.isArray(content) ? content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ") : ""
      const said = speakable(text)
      if (said) window.speechSynthesis.speak(new SpeechSynthesisUtterance(said))
    }
  }, [messages, on, supported])

  return { supported, on, toggle }
}
