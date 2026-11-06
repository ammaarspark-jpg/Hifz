// Keeps the app itself available offline. The speech model is cached separately by the engine.
const CACHE = "hifz-app-v1";
const FILES = ["./", "index.html", "data.js", "engine.js", "recite.js", "asr-worker.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "amiri-quran.woff2"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== "GET") return;
  // network first so updates arrive; fall back to the cached copy offline
  e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))));
});
