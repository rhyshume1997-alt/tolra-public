import { NextResponse } from "next/server";

// The service worker, stamped with this deploy's version so browsers notice a new deploy (a byte-different script).
// Served from the root so its scope covers the whole app. Never cached by the browser's HTTP cache.

const VERSION = JSON.stringify(process.env.NEXT_PUBLIC_APP_VERSION || "dev");

const SOURCE = `/* The app's service worker (served by app/sw.js/route.ts with this deploy's version).
 *
 * Caches ONLY public, build-fingerprinted static files (/_next/static/*, the offline page and app icons) so the app
 * opens fast and shows a friendly page when there is no connection. It never stores pages, API responses, Supabase
 * responses or anything else that belongs to a signed-in person or company: the app is multi-company, and a
 * shared device must never show one company's data to another.
 *
 * Updates: each deploy serves a different VERSION, so the browser installs the new worker on its next update check.
 * It waits until the app asks it to take over (the "New version available" prompt), then old caches are deleted.
 */

const VERSION = __VERSION__;
// -icons2: the Tolra app icon replaced the per-company icons; a new cache name clears anything cached before.
const CACHE = \`quoteflow-static-icons2-\${VERSION}\`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("quoteflow-") && key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data && event.data.type === "VERSION" && event.ports[0]) event.ports[0].postMessage(VERSION);
});

function isStaticAsset(url) {
  return url.pathname.startsWith("/_next/static/") || url.pathname === OFFLINE_URL;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Supabase and every other origin: straight to the network, untouched.
  if (url.origin !== self.location.origin) return;
  // API routes, the manifest and icons (they depend on who is signed in): network only.
  if (url.pathname.startsWith("/api/") || url.pathname === "/manifest.webmanifest") return;

  if (request.mode === "navigate") {
    // Pages are never cached (they can carry a company's data). Offline: show the offline page instead.
    event.respondWith(fetch(request).catch(async () => (await caches.match(OFFLINE_URL)) || Response.error()));
    return;
  }

  // React Server Component payloads are per-person data: network only.
  if (request.headers.get("RSC") || url.searchParams.has("_rsc")) return;

  if (isStaticAsset(url)) {
    // Fingerprinted build files never change: cache first, but only from THIS deploy's cache. Never caches.match()
    // across caches: a file left in an older deploy's cache is never served. A file the network no longer has (an
    // old tab asking for a chunk of a previous build) comes back as the network's error, so the page's error
    // boundary reloads once onto the new build (lib/chunk-reload.ts); errors are never cached.
    event.respondWith(
      caches.open(CACHE).then((cache) => cache.match(request)).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok && response.type === "basic") {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
`;

export function GET() {
  return new NextResponse(SOURCE.replace("__VERSION__", VERSION), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Service-Worker-Allowed": "/",
    },
  });
}
