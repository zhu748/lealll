# syntax=docker/dockerfile:1
# Bun-based Dockerfile for zcode-proxy — designed for Render (and any other
# container host that supports Docker: Fly.io, Railway, Cloud Run, etc.).
#
# Why Bun (not Node)?
#   - server.ts uses Bun.serve() directly, so we MUST run on Bun.
#   - oven/bun:1.2-debian is a slim image that supports both Bun runtime
#     and standard Linux glibc/musl tools Render's healthcheck needs.
#     Note: bun.lock uses the new JSON lockfile format (lockfileVersion: 1)
#     introduced in Bun 1.2, so we MUST use Bun >= 1.2 here.

FROM oven/bun:1.2-debian AS base

# Render injects PORT at runtime. We default to 8080 for local `docker run`.
ENV ZCODE_PROXY_PORT=8080 \
    ZCODE_PROXY_CONFIG=/data/config.yaml \
    ZCODE_PROXY_STORE_DIR=/data/.zcode-proxy \
    NODE_ENV=production

WORKDIR /app

# --- Dependencies (cached layer) ---
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- Source ---
COPY tsconfig.json ./
COPY src ./src
COPY config.example.yaml ./
COPY index.html ./
COPY render-start.sh ./
RUN chmod +x render-start.sh

# Writable data dir. On Render free tier this is ephemeral (lost on restart);
# on paid Render with a persistent disk mounted at /data it survives restarts.
# /data is only needed if you want OAuth multi-account credentials to persist
# across deploys. In apikey mode (the recommended Render setup), /data only
# holds the auto-generated config.yaml — losing it on restart is harmless
# because env vars repopulate the secrets.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080

# Render uses TCP health checks via healthCheckPath in render.yaml, but we
# also bake in a Docker HEALTHCHECK for non-Render hosts (Fly.io, Cloud Run).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+process.env.ZCODE_PROXY_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# render-start.sh:
#   1. Maps Render's $PORT -> $ZCODE_PROXY_PORT
#   2. Falls back to /tmp if /data is not writable (free tier without disk)
#   3. Seeds config.yaml from env vars on first run
CMD ["./render-start.sh"]
