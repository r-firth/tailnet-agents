import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function worker() {
  const handlers = new Map();
  const cached = new Map();
  const removed = [];
  let network = async () => new Response("current app");
  runInNewContext(
    readFileSync(new URL("../web/public/sw.js", import.meta.url), "utf8"),
    {
      URL,
      Response,
      fetch: (...args) => network(...args),
      caches: {
        open: async () => ({
          addAll: async (paths) =>
            paths.forEach((path) =>
              cached.set(
                path,
                new Response("Connect to Tailscale to reach your Hub"),
              ),
            ),
          match: async (path) => cached.get(path)?.clone(),
        }),
        keys: async () => ["hub-offline-old", "unrelated-cache"],
        delete: async (name) => removed.push(name),
      },
      self: {
        location: { origin: "https://hub.test" },
        addEventListener: (name, handler) => handlers.set(name, handler),
        skipWaiting: async () => {},
        clients: { claim: async () => {} },
      },
    },
  );
  return {
    cached,
    removed,
    network: (fn) => {
      network = fn;
    },
    async lifecycle(name) {
      let done;
      handlers.get(name)({
        waitUntil: (promise) => {
          done = promise;
        },
      });
      await done;
    },
    request(path, mode = "navigate", method = "GET") {
      let response;
      handlers.get("fetch")({
        request: { url: `https://hub.test${path}`, mode, method },
        respondWith: (value) => {
          response = value;
        },
      });
      return response;
    },
  };
}

test("navigations always load the current deployment and fall back only when offline", async () => {
  const sw = worker();
  await sw.lifecycle("install");
  assert.equal(await (await sw.request("/memory")).text(), "current app");
  sw.network(async () => new Response("new deployment"));
  assert.equal(await (await sw.request("/sessions")).text(), "new deployment");
  sw.network(async () => {
    throw new TypeError("Offline");
  });
  assert.match(await (await sw.request("/")).text(), /Connect to Tailscale/);
  assert.deepEqual([...sw.cached.keys()], ["/offline.html"]);
});

test("service worker never intercepts API, artifacts, build checks or mutations", async () => {
  const sw = worker();
  for (const path of [
    "/api/state",
    "/api/artifacts/image.png",
    "/api/sessions/id/stream",
    "/build.json",
    "/assets/app.js",
  ]) {
    assert.equal(sw.request(path, "cors"), undefined);
  }
  assert.equal(sw.request("/api/state", "navigate"), undefined);
  assert.equal(sw.request("/api/chats", "navigate", "POST"), undefined);
});

test("a stopped backend shows connection help while authentication errors pass through", async () => {
  const sw = worker();
  await sw.lifecycle("install");
  sw.network(async () => new Response("Bad gateway", { status: 502 }));
  assert.match(await (await sw.request("/")).text(), /Connect to Tailscale/);
  sw.network(async () => new Response("Sign in", { status: 401 }));
  assert.equal((await sw.request("/")).status, 401);
});

test("upgrading removes only this app's obsolete offline cache", async () => {
  const sw = worker();
  await sw.lifecycle("activate");
  assert.deepEqual(sw.removed, ["hub-offline-old"]);
});
