// Pato service worker: Smart alerts (push notifications) and a fast open.
// Marco Nov 25: "the app can open faster". The app shell (page + scripts + icons) is served from the phone's cache instantly and refreshed in the background, so the next open is current. A new version is picked up by the version check in the page (it reloads with ?v=...), which always goes to the network. Data, fonts and workers are never cached here.
const SHELL = "pato-shell-1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => { for (const k of await caches.keys()) if (k.startsWith("pato-shell-") && k !== SHELL) await caches.delete(k); await self.clients.claim(); })()));
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== self.location.origin || /version\.json$|sw\.js$/.test(u.pathname)) return;
  if (!(r.mode === "navigate" || /\.(js|png|webmanifest|svg|css)$/.test(u.pathname) || /\/$/.test(u.pathname))) return;
  e.respondWith((async () => {
    const c = await caches.open(SHELL), hit = await c.match(r);
    const net = fetch(r).then(res => { if (res && res.ok && res.type === "basic") c.put(r, res.clone()).catch(() => 0); return res; });
    if (hit) { e.waitUntil(net.catch(() => 0)); return hit; }
    return net;
  })());
});
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
    const u = (e.notification.data && e.notification.data.url) || "./";
    for (const c of all) { if ("focus" in c) { if (/remind/.test(u)) c.postMessage({ go: "remind" }); return c.focus(); } }
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || "./");
  })());
});
