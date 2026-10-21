// Only for notifications: phones show them through a service worker, and
// tapping one opens its session. No caching, so a new build is never stale.
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  // A session's notice opens it; anything else opens the "Needs you" overview.
  const id = event.notification.data?.sessionId
  const url = new URL(id ? `/#/s/${id}` : "/#/overview", self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) return open.navigate(url).then((w) => (w ?? open).focus())
      return self.clients.openWindow(url)
    }),
  )
})

// The controller encrypts what a notice says for this device (the browser
// decrypts it before it gets here), so the push service can't read it.
// Pushes to devices subscribed before that are empty: a generic notice.
self.addEventListener("push", (event) => {
  let notice = null
  try {
    notice = event.data ? event.data.json() : null
  } catch {
    notice = null
  }
  event.waitUntil(
    self.registration.showNotification(notice?.title ?? "Seraph", {
      body: notice?.body ?? "A session needs you or has finished.",
      icon: "/icon-192.png",
      tag: notice?.tag ?? "seraph",
      renotify: true,
      data: { sessionId: notice?.sessionId ?? null },
    }),
  )
})
