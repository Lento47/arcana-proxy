// src/warm.ts — Cloudflare Worker that:
//   1. Re-exports the OmniRouteContainer class (owned by src/container.ts)
//      so the durable_objects migration has a class to bind to.
//   2. Consumes the warm-up queue and pings the container's /healthz.

import { getContainer } from "@cloudflare/containers"
import { OmniRouteContainer } from "./container"

export { OmniRouteContainer }

interface Env {
  OMNIRoute: DurableObjectNamespace<OmniRouteContainer>
}

export default {
  async queue(batch: MessageBatch<{ kind: string; ts: number }>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        // getContainer gives us a stub that .fetch()es into the container.
        // Any response (or thrown error) counts as "warmed".
        const inst = getContainer(env.OMNIRoute, "primary")
        await inst.fetch(new Request("http://container/healthz", { method: "GET" })).catch(() => null)
      } catch {
        // Swallow — the next producer tick will retry.
      } finally {
        msg.ack()
      }
    }
  },
}
