# Multi-stage build for the Agent Commons monorepo.
# Builds into a slim Node image with only the api app + runtime deps.

# ─── Stage 1: install deps + build ────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Enable corepack so pnpm matches our lockfile version
RUN corepack enable

# Install only what's needed to install + resolve workspaces
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/mcp/package.json ./apps/mcp/package.json
COPY packages/schema/package.json ./packages/schema/package.json
COPY packages/scribe/package.json ./packages/scribe/package.json
COPY packages/sdk-node/package.json ./packages/sdk-node/package.json
COPY packages/verifier/package.json ./packages/verifier/package.json

# Install with frozen lockfile — fail if pnpm-lock.yaml is stale
RUN pnpm install --frozen-lockfile

# Now copy source
COPY apps ./apps
COPY packages ./packages
COPY seed ./seed
COPY docs ./docs

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# tini for proper signal handling (graceful shutdown on SIGTERM from Fly)
RUN apt-get update && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Copy everything from deps stage — we use tsx in production so we don't need
# a separate build step. The image is still <300MB.
COPY --from=deps /app /app

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Run the API as a non-root user
RUN useradd --create-home --shell /bin/bash commons \
  && chown -R commons:commons /app
USER commons

ENTRYPOINT ["tini", "--"]
CMD ["pnpm", "--filter", "@commons/api", "start"]
