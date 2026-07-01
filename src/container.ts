// src/container.ts — shared OmniRoute Container class.
// The warm Worker (src/warm.ts) exports it (needed for the durable_objects
// migration). The proxy Worker (src/index.ts) only needs the type; it reaches
// the container via the DO binding declared in wrangler.jsonc.

import { Container } from "@cloudflare/containers"

export class OmniRouteContainer extends Container {
  // OmniRoute's default listen port (per upstream Dockerfile: PORT=20128).
  // Override at runtime by setting the PORT env var on the container if the
  // image is configured to listen on a different port.
  defaultPort = 20128
  // Keep the container warm for 10 minutes after the last request so
  // subsequent traffic stays fast.
  sleepAfter = "10m"
}
