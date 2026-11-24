# The image for hosted agent runs: the `stdartifacts` CLI and the Claude Agent SDK.
# Build from the repo root. Cloudflare runs linux/amd64.
FROM --platform=linux/amd64 node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "stdartifacts..."
RUN pnpm --filter stdartifacts build

FROM --platform=linux/amd64 node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /repo/apps/cli/dist/stdartifacts.mjs ./stdartifacts.mjs
COPY --from=build /repo/apps/runner/run.sh ./run.sh
RUN npm init -y >/dev/null && npm install --omit=dev @anthropic-ai/claude-agent-sdk@0.3.316 playwright-core@1.56.1 && chmod +x run.sh
ENTRYPOINT ["/app/run.sh"]
