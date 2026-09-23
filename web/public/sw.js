// Only the connection screen is stored offline. Workspace data and app builds
// always come from the server, so installation cannot pin an old frontend.
const CACHE = "hub-offline-v2";
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(["/offline.html"]))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("hub-offline-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    request.mode !== "navigate" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.status >= 500)
          throw new Error("Tailnet Agents unavailable");
        return response;
      })
      .catch(async () =>
        (await caches.open(CACHE)).match("/offline.html").then(
          (response) =>
            response ||
            new Response(
              "Tailnet Agents is unreachable. Connect to Tailscale and try again.",
              {
                status: 503,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
              },
            ),
        ),
      ),
  );
});
