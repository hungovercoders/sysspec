# Deploying the sysspec demo

The demo is one deployable unit built from the same spec commit: the
generated docs site and the read-only spec MCP server. Anything that can
serve static files and run the stateless streamable-HTTP MCP server can
host it — the server keeps no session state and reads specs from a baked
bundle (`mcp/scripts/bundle-specs.mjs`), so there is no filesystem or
database dependency.

## Cloudflare (implemented — this repo's demo)

One Worker (`deploy/cloudflare/`): the docs site as static assets at `/`,
the MCP server at `/mcp` via `nodejs_compat` (the unchanged `node:http`
server behind `httpServerHandler`).

- `cloudflare-deploy.yml` deploys on every main push.
- `cloudflare-preview.yml` uploads a version per PR with a stable
  `pr-<number>` preview alias and comments the URL — the preview is the
  *whole system* (docs + live MCP) at that PR's spec commit.
- Repo secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit) and
  `CLOUDFLARE_ACCOUNT_ID`.

Local run: `task docs:build` with `DOCS_SITE_BASE=/`, then
`npm run dev` in `deploy/cloudflare/`.

## AWS (known option, not implemented)

The same two halves map directly:

- **Site** — upload `site/` (built with `DOCS_SITE_BASE=/`) to S3 behind
  CloudFront. PR previews: a bucket prefix or a per-PR CloudFront
  Function-routed path, or AWS Amplify Hosting, which has built-in PR
  previews.
- **MCP server** — the published container image
  (`ghcr.io/hungovercoders/sysspec-mcp`, built by `mcp-image.yml`) runs
  as-is on App Runner, Lambda (with the web adapter), or Fargate: it is a
  plain stateless HTTP server configured by `PORT`/`HOST` env vars, so
  scale-to-zero hosts work.

The split exists because AWS has no single primitive serving both halves;
on Cloudflare one Worker does. If AWS becomes a real target, mirror
`cloudflare-deploy.yml` with an OIDC role (`aws-actions/configure-aws-credentials`)
instead of an API-token secret.
