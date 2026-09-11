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
COPY scripts/third-party-notices.mjs /scripts/third-party-notices.mjs
RUN npm ci --no-audit --no-fund
COPY mcp/src ./src
RUN npm run build
# The image ships stdio.mjs alone, so its notices are generated for that
# bundle (npm's dist/THIRD_PARTY_NOTICES.txt covers both entrypoints).
RUN node /scripts/third-party-notices.mjs --title "the sysspec-mcp container image (sysspec-mcp.mjs)" \
      --bundle dist/stdio.mjs --out dist/THIRD_PARTY_NOTICES.image.txt

FROM node:24-slim
WORKDIR /app
COPY --from=build /build/dist/stdio.mjs ./sysspec-mcp.mjs
# The bundle inlines its dependencies; their notices and this project's
# license travel with it.
COPY --from=build /build/dist/THIRD_PARTY_NOTICES.image.txt ./THIRD_PARTY_NOTICES.txt
COPY LICENSE ./LICENSE
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
