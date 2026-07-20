// src/warm.ts — Cloudflare Worker that:
//   1. Re-exports the OmniRouteContainer class (owned by src/container.ts)
//      so the durable_objects migration has a class to bind to.
//   2. Consumes the warm-up queue and pings the container's /healthz.
//   3. Exposes a /__diag/* route (DIAG_KEY-gated) to introspect the
//      running container during the one-time setup. NOT for production
//      traffic; rotate DIAG_KEY after setup is complete.

import { getContainer } from "@cloudflare/containers"
import { OmniRouteContainer } from "./container"

export { OmniRouteContainer }

interface Env {
  OMNIRoute: DurableObjectNamespace<OmniRouteContainer>
  DIAG_KEY?: string
  OMNIRoute_WARM_QUEUE?: Queue
  // Bootstrap secret for OmniRoute's management dashboard. Read on every cold
  // start and passed as an env var to the container. Set via:
  //   npx wrangler secret put OMNIRoute_INITIAL_PASSWORD -c wrangler.warm.jsonc
  // After the first key is created via /__diag/setup, this can be removed.
  OMNIRoute_INITIAL_PASSWORD?: string
}

function isDiagAuthorized(req: Request, env: Env): boolean {
  if (!env.DIAG_KEY) return false
  const url = new URL(req.url)
  const k = url.searchParams.get("key") ?? req.headers.get("x-diag-key")
  return k === env.DIAG_KEY
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export default {
  // Warm-up consumer: force the container to boot by hitting its healthz.
  // On cold start, pass the management password as an env var so the
  // dashboard can be logged into for one-time key provisioning.
  async queue(batch: MessageBatch<{ kind: string; ts: number }>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const stub = getContainer(env.OMNIRoute, "primary") as unknown as {
          startAndWaitForPorts: (opts?: { startOptions?: { envVars?: Record<string, string> } }) => Promise<unknown>
          fetch: (req: Request) => Promise<Response>
        }
        try {
          await stub.startAndWaitForPorts({
            startOptions: { envVars: { INITIAL_PASSWORD: env.OMNIRoute_INITIAL_PASSWORD ?? "" } },
          })
        } catch {
          // startAndWaitForPorts errors when the container is already running
          // (or the runtime doesn't expose it on this stub). Fall through to
          // a plain fetch — the instance is alive either way.
        }
        await stub
          .fetch(new Request("http://container/api/monitoring/health", { method: "GET" }))
          .catch(() => null)
      } catch {
        // Swallow — the next producer tick will retry.
      } finally {
        msg.ack()
      }
    }
  },

  // Service-binding RPC: called by the proxy Worker via
  // `env.OMNIRoute_WARM.omFetch(req)`. Forwards the request to the running
  // container, returning whatever the container responds with. The proxy
  // cannot reach the container directly because the container app is owned
  // by THIS Worker (Cloudflare Containers are 1:1 with their owning Worker).
  async omFetch(req: Request, env: Env): Promise<Response> {
    const stub = getContainer(env.OMNIRoute, "primary")
    return stub.fetch(req)
  },

  // Diag surface — read-only introspection. Use to grab the auto-generated
  // OmniRoute API key from the dashboard API after the first cold start.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (!url.pathname.startsWith("/__diag/")) {
      return new Response("not found", { status: 404 })
    }
    if (!isDiagAuthorized(req, env)) {
      return new Response("unauthorized", { status: 401 })
    }

    const inst = getContainer(env.OMNIRoute, "primary")

    // GET /__diag/healthz — verify the container is alive
    if (url.pathname === "/__diag/healthz") {
      const r = await inst
        .fetch(new Request("http://container/api/monitoring/health", { method: "GET" }))
        .catch((e) => ({ error: String(e) }))
      if (r instanceof Response) {
        return json({ status: r.status, body: await r.text() }, r.status)
      }
      return json(r)
    }

    // GET /__diag/keys — pull the OmniRoute API key(s) from the dashboard.
    // OmniRoute's /api/keys endpoint returns the master/admin key. The proxy
    // stores it as OMNIRoute_KEY (single key pool for now, mirrors OpenRouter).
    if (url.pathname === "/__diag/keys") {
      const r = await inst
        .fetch(new Request("http://container/api/keys", { method: "GET" }))
        .catch((e) => ({ error: String(e) }))
      if (r instanceof Response) {
        return json({ status: r.status, body: await r.text() }, r.status)
      }
      return json(r)
    }

    // GET /__diag/raw?path=/foo — proxy any path inside the container.
    // Useful for poking around the dashboard API.
    if (url.pathname === "/__diag/raw") {
      const inner = url.searchParams.get("path") ?? "/"
      const r = await inst
        .fetch(new Request(`http://container${inner}`, { method: req.method }))
        .catch((e) => ({ error: String(e) }))
      if (r instanceof Response) {
        return json({ status: r.status, body: await r.text() }, r.status)
      }
      return json(r)
    }

    // GET /__diag/warm — enqueue a warm-up message. Used to cold-start the
    // container manually before we have an OmniRoute key (so the proxy can
    // route to it). Idempotent: container boots on the first ping.
    if (url.pathname === "/__diag/warm") {
      if (!env.OMNIRoute_WARM_QUEUE) {
        return json({ error: "no_queue_binding" }, 500)
      }
      await env.OMNIRoute_WARM_QUEUE.send({ kind: "warm", ts: Date.now() })
      return json({ ok: true, sent: "warm" })
    }

    // GET /__diag/restart — destroy the current container instance. The next
    // warm/ping will cold-start a new one with the latest env_vars from
    // wrangler.warm.jsonc. Use after editing env_vars to apply them.
    if (url.pathname === "/__diag/restart") {
      try {
        // The stub is a DurableObjectStub<OmniRouteContainer>; .destroy()
        // is an instance method that SIGKILLs the running container.
        const stub = getContainer(env.OMNIRoute, "primary") as { destroy: () => Promise<void> }
        await stub.destroy()
        return json({ ok: true, destroyed: true })
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500)
      }
    }

    // GET /__diag/setup?password=X — one-shot bootstrap. Logs in to the
    // OmniRoute dashboard with the given password, then creates a new API
    // key with the proxy's required scopes. Returns the unmasked key.
    //
    // DELETE this endpoint after the initial setup is complete.
    if (url.pathname === "/__diag/setup") {
      const password = url.searchParams.get("password") ?? req.headers.get("x-setup-password")
      if (!password) return json({ error: "missing_password" }, 400)
      try {
        // Step 1: login. Cookie jar stored in a closure.
        const jar = new Map<string, string>()
        const loginRes = await inst
          .fetch(
            new Request("http://container/api/auth/login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ password }),
            }),
          )
          .catch((e) => ({ error: String(e) }))
        if (!(loginRes instanceof Response)) {
          return json({ step: "login", error: "fetch_threw", detail: loginRes })
        }
        const setCookie = loginRes.headers.get("set-cookie") ?? ""
        const m = setCookie.match(/auth_token=([^;]+)/)
        if (!m) {
          const body = await loginRes.text().catch(() => "")
          return json({ step: "login", status: loginRes.status, body }, loginRes.status)
        }
        jar.set("auth_token", m[1])

        // Step 2: create a key. The key's "key" field is returned UNMASKED in
        // the POST response (only GET masks it). We name it "arcana-proxy".
        const keyRes = await inst
          .fetch(
            new Request("http://container/api/keys", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                cookie: `auth_token=${jar.get("auth_token")}`,
              },
              body: JSON.stringify({
                name: "arcana-proxy",
                noLog: false,
                scopes: ["chat", "embeddings"],
                allowUsageCommand: true,
                usageLimitEnabled: false,
              }),
            }),
          )
          .catch((e) => ({ error: String(e) }))
        if (!(keyRes instanceof Response)) {
          return json({ step: "create_key", error: "fetch_threw", detail: keyRes })
        }
        const keyBody = await keyRes.text()
        return json({ loginStatus: loginRes.status, keyStatus: keyRes.status, keyBody })
      } catch (e) {
        return json({ error: String(e) }, 500)
      }
    }

    return new Response("unknown diag route", { status: 404 })
  },
}
