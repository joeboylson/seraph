import { db, settings } from "./supabase"

const supported = () => "serviceWorker" in navigator && "PushManager" in window && Boolean(settings.vapidPublicKey)

function keyBytes(base64url: string) {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4)
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

/** Subscribe this device to push and save it. True if push is on. */
export async function subscribePush(): Promise<boolean> {
  if (!supported() || Notification.permission !== "granted") return false
  try {
    const registration = await navigator.serviceWorker.ready
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(settings.vapidPublicKey!) }))
    // Its keys let the controller encrypt what a notification says for this
    // device only. Saved again each visit, so devices from before get them too.
    const keys = subscription.toJSON().keys ?? {}
    const { error } = await db
      .from("push_subscriptions")
      .upsert({ endpoint: subscription.endpoint, p256dh: keys.p256dh ?? null, auth: keys.auth ?? null }, { onConflict: "endpoint" })
    return !error
  } catch {
    return false // e.g. iPhone outside an installed home-screen app
  }
}

/** Stop pushes to this device, e.g. when signing out. */
export async function unsubscribePush() {
  if (!("serviceWorker" in navigator)) return
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return
  await db.from("push_subscriptions").delete().eq("endpoint", subscription.endpoint)
  await subscription.unsubscribe()
}

export async function signOut() {
  await unsubscribePush().catch(() => {})
  await db.auth.signOut()
}
