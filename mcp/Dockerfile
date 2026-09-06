# Serve this repo's specs over streamable-HTTP MCP — the portable URL
# deployment. Runs unchanged on any container host (Coolify, AWS App
# Runner/ECS, Cloud Run, Cloudflare Containers, a VPS).
#
# Build from the repo root so specs/ is in context:
#
#   docker build -f mcp/Dockerfile -t sysspec-mcp .
#   docker run --rm -p 8080:8080 sysspec-mcp
#
# The MCP endpoint is http://localhost:8080/mcp. CI publishes this image
# to ghcr.io/hungovercoders/sysspec-mcp on every push to main.
FROM node:24-slim AS build
WORKDIR /build
COPY mcp/package.json mcp/package-lock.json mcp/tsconfig.json mcp/tsup.config.ts ./
RUN npm ci --no-audit --no-fund
COPY mcp/src ./src
COPY mcp/scripts ./scripts
COPY skills ./skills
# Regenerate the baked skills bundle in-image (after the src COPY, so any
# stale locally generated file loses), then bundle.
RUN SKILLS_DIR=./skills node scripts/bundle-skills.mjs && npx tsup

FROM node:24-slim
WORKDIR /app
COPY --from=build /build/dist/stdio.mjs ./sysspec-mcp.mjs
COPY specs ./specs

# Host-allowlist hardening for a public hostname is opt-in:
# set SYSSPEC_MCP_ALLOWED_HOSTS=mcp.example.com (comma-separated).
ENV SPECS_DIR=/app/specs \
    SYSSPEC_MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080
USER node
CMD ["node", "/app/sysspec-mcp.mjs"]
