# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
# --production: only runtime deps ship in the image. The sole build step below
# (build-fork-worker.ts) uses Bun built-ins only — devDependencies (@types/bun,
# esbuild, tsc) would otherwise land in the final image (~+40MB of attack
# surface and layer weight) with zero consumer.
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json config.example.yaml ./
COPY src ./src
COPY scripts ./scripts
# The image runs TS sources — bundle the worker entry here (gitignored build
# input) or the solver silently falls back to main-thread solving. Fail the
# build if the asset is missing: a silent fallback ships the exact
# main-thread-freezing mode the worker design exists to avoid.
RUN bun run scripts/build-fork-worker.ts \
  && test -f src/proxy/captcha-worker-entry.bundle.js \
  && rm -rf scripts
RUN mkdir -p /data && chown bun:bun /data
ENV ZCODE_PROXY_PORT=8080
ENV ZCODE_PROXY_CONFIG=/data/config.yaml
EXPOSE 8080
USER bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${ZCODE_PROXY_PORT:-8080}/health" >/dev/null 2>&1 || exit 1
CMD ["bun", "run", "src/index.ts", "serve"]
