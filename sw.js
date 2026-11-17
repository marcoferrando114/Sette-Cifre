// Pato service worker: shows Smart alerts (push notifications). No offline caching.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  // iPhone already adds its own "from Pato" line under the title, so the title is the alert's own heading
  // ("Payment received") and "Pato" shows once (Marco, Nov 15)
  e.waitUntil(self.registration.showNotification(d.title || "Pato", {
    body: d.body || "", icon: "icon-192.png", badge: "icon-192.png", tag: d.tag || undefined, data: { url: d.url || "./" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) return c.focus(); }
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || "./");
  })());
});
