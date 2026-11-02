// Paydlux approver — offline shell cache.
//
// What this caches, and what it must never cache:
//
//   CACHED   index.html, app.js, xdr.js, the icons, the manifest. These are the
//            app itself: client code with no secret and no payment data in it,
//            byte-identical for every visitor. Caching them is what lets the
//            installed app launch from the home screen with no signal and still
//            show its own key, instead of a Safari error page.
//
//   NEVER    /queue, /challenge/*, /signed/*, /approve, /deny, /list, /healthz,
//            or anything carrying ?k=. Those hold payment amounts, payee
//            addresses, signed transactions and the portal key. A payment
//            answer left in a cache is a payment answer a later request could
//            be shown instead of a live one — and approving a stale challenge is
//            exactly the failure this app exists to prevent.
//
// Strategy: network-first for the shell, so an online phone always runs the
// current code (a security fix must reach it on the next open, not the next
// reinstall). Cache is the fallback when the network is not there at all.
const SHELL = [
  "./",
  "./app.js",
  "./xdr.js",
  "./verify.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
];
const CACHE = "paydlux-approver-v3";

// A path is cacheable only if it is one of the shell files, by exact name.
// Everything else — including any future API route — falls through untouched.
const isShell = (url) => {
  if (url.search !== "") return false;                 // any query = never cached
  const file = url.pathname.replace(/^.*\/phone\//, "").replace(/\/$/, "") || "index.html";
  return ["", "index.html", "app.js", "xdr.js", "verify.js", "manifest.webmanifest",
          "icon-192.png", "icon-512.png"].includes(file);
};

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // Individual puts, not addAll: one missing icon must not abort the shell.
    for (const path of SHELL) {
      try { await c.add(new Request(path, { cache: "reload" })); } catch { /* keep going */ }
    }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Drop every older shell cache. An old app.js sitting around is old signing
    // code, and signing code is the one thing that must not go stale.
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || !isShell(url)) return;
  e.respondWith((async () => {
    try {
      const fresh = await fetch(e.request, { cache: "reload" });
      if (fresh.ok) {
        const copy = fresh.clone();
        const c = await caches.open(CACHE);
        await c.put(url.pathname, copy);
      }
      return fresh;
    } catch {
      return (await caches.match(url.pathname))
        // No cached shell either: answer plainly rather than let the browser
        // show its own error page over the app.
        || new Response("offline", { status: 503, headers: { "content-type": "text/plain" } });
    }
  })());
});
