import { useEffect, useRef, useState } from "react"
import { sessionTitle } from "@/components/SessionList"
import { subscribePush } from "@/lib/push"
import type { Session, SessionStatus } from "@/lib/types"

const supported = typeof window !== "undefined" && "Notification" in window

// Phones only show notifications through a service worker (and Android
// refuses `new Notification`), so register one where it's allowed.
const worker = supported && "serviceWorker" in navigator ? navigator.serviceWorker.register("/sw.js").catch(() => null) : Promise.resolve(null)

async function notify(s: Session, body: string, open: (id: string) => void) {
  const registration = await worker
  if (registration) {
    await registration.showNotification(sessionTitle(s), { body, tag: s.id, icon: "/icon-192.png", data: { sessionId: s.id } })
    return
  }
  const n = new Notification(sessionTitle(s), { body, tag: s.id })
  n.onclick = () => {
    window.focus()
    open(s.id)
    n.close()
  }
}

/**
 * Tell the person when a session needs them or finishes, while the page
 * is in the background. Also puts the count of waiting sessions in the tab title.
 */
export function useNotifications(sessions: Session[], open: (id: string) => void) {
  const [permission, setPermission] = useState(supported ? Notification.permission : "denied")
  // With push on, the controller notifies this device even when the page is
  // closed, so the page doesn't add its own (that would buzz twice).
  const [pushOn, setPushOn] = useState(false)
  const previous = useRef(new Map<string, SessionStatus>())

  useEffect(() => {
    if (permission === "granted") subscribePush().then(setPushOn)
  }, [permission])

  useEffect(() => {
    const waiting = sessions.filter((s) => s.status === "waiting").length
    document.title = waiting ? `(${waiting}) Seraph` : "Seraph"

    for (const s of sessions) {
      const before = previous.current.get(s.id)
      previous.current.set(s.id, s.status)
      if (!before || before === s.status || permission !== "granted" || pushOn || !document.hidden) continue
      let body: string | null = null
      if (s.status === "waiting") body = "Claude needs you"
      else if (s.status === "idle" && before === "working") body = "Claude finished"
      if (!body) continue
      notify(s, body, open).catch(() => {})
    }
  }, [sessions, permission, pushOn, open])

  const ask = supported && permission === "default"
    ? async () => setPermission(await Notification.requestPermission())
    : null
  return { ask }
}
