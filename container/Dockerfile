# container/Dockerfile — builds the OmniRoute image for Cloudflare Containers.
#
# The upstream OmniRoute Dockerfile (https://github.com/diegosouzapw/OmniRoute)
# expects the full repo as its build context. To avoid committing hundreds of
# MB of vendored source, we wrap it: this Dockerfile clones the pinned OmniRoute
# tag into the builder stage, then runs the upstream Dockerfile's build steps
# directly. The runner stage also follows the upstream layout.
#
# Pin: bump OMR_TAG to upgrade. v3.8.42 (latest as of 2026-06-30).

ARG OMR_TAG=v3.8.42

# ── Builder ────────────────────────────────────────────────────────────────
FROM node:24-trixie-slim AS builder
ARG OMR_TAG
WORKDIR /src

# Build tools for native module compilation. The upstream Dockerfile installs
# these in its `builder` stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Clone the pinned OmniRoute tag shallowly. The upstream Dockerfile does
# `npm ci` against the committed package-lock.json, so we MUST preserve that
# file — the full history is needed because the lockfile references exact
# resolved versions. Shallow clone is enough; the lockfile is in the snapshot.
RUN git clone --depth 1 --branch ${OMR_TAG} https://github.com/diegosouzapw/OmniRoute.git omniroute
WORKDIR /src/omniroute

# Refresh npm to clear stale bundled deps flagged by container scanners
# (per upstream Dockerfile notes).
RUN npm install -g npm@latest && npm cache clean --force

# Workspace package manifests must be present before `npm ci` (upstream
# requirement — see comments in upstream Dockerfile). The full clone already
# includes these, but we make the dependency explicit.
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true

RUN test -f package-lock.json \
  || (echo "package-lock.json is required for reproducible Docker builds" >&2 && exit 1)

RUN --mount=type=cache,target=/root/.npm \
  npm ci --no-audit --no-fund --legacy-peer-deps --ignore-scripts \
  && npm rebuild better-sqlite3 \
  && node -e "require('better-sqlite3')(':memory:').close()"

ENV OMNIROUTE_USE_TURBOPACK=0

# Build with webpack (stable). The upstream Dockerfile has a long comment
# explaining why Turbopack is disabled — leaving that comment out here for
# brevity. See https://github.com/diegosouzapw/OmniRoute/blob/main/Dockerfile
ARG OMNIROUTE_BUILD_MEMORY_MB=4096
ENV NODE_OPTIONS="--max-old-space-size=${OMNIROUTE_BUILD_MEMORY_MB}"

RUN --mount=type=cache,target=/app/.build/next/cache \
  mkdir -p /app/data && npm run build

# ── Runner ─────────────────────────────────────────────────────────────────
FROM node:24-trixie-slim AS runner
ARG OMR_TAG

LABEL org.opencontainers.image.title="arcana-omniroute" \
  org.opencontainers.image.description="OmniRoute upstream (${OMR_TAG}) packaged for Cloudflare Containers" \
  org.opencontainers.image.source="https://github.com/diegosouzapw/OmniRoute" \
  org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV OMNIROUTE_MEMORY_MB=1024
ENV NODE_OPTIONS="--max-old-space-size=${OMNIROUTE_MEMORY_MB}"
ENV DATA_DIR=/app/data
ENV OMNIROUTE_MIGRATIONS_DIR=/app/migrations

WORKDIR /app

# Refresh npm to clear stale bundled deps at runtime (per upstream Dockerfile).
RUN apt-get update \
  && apt-get install -y --no-install-recommends libsecret-1-0 ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g npm@latest && npm cache clean --force \
  && mkdir -p /app/data

# Copy the standalone build output + better-sqlite3 (one exception, per
# upstream Dockerfile).
COPY --from=builder /src/omniroute/.build/next/standalone ./
COPY --from=builder /src/omniroute/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /src/omniroute/scripts/dev/healthcheck.mjs ./healthcheck.mjs

# Persist the data dir under the non-root `node` user (UID/GID 1000).
RUN chown -R node:node /app
USER node

EXPOSE 20128

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

CMD ["node", "dev/run-standalone.mjs"]
