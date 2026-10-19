// Only for notifications: phones show them through a service worker, and
// tapping one opens its session. No caching, so a new build is never stale.
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const id = event.notification.data?.sessionId
  const url = new URL(id ? `/#/s/${id}` : "/", self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) return open.navigate(url).then((w) => (w ?? open).focus())
      return self.clients.openWindow(url)
    }),
  )
})

// The controller's pushes are empty on purpose (nothing about a session goes
// through the push service), so the notice is generic and opens the page.
self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("Seraph", {
      body: "A session needs you or has finished.",
      icon: "/icon-192.png",
      tag: "seraph",
      renotify: true,
    }),
  )
})
