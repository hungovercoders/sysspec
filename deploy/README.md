# Deploying the sysspec demo

The demo is live at **<https://demo.sysspec.dev>** (spec catalog at `/`, MCP
endpoint at `/mcp`), its mocks at **<https://mocks.sysspec.dev>**, and the
tool's own website at **<https://sysspec.dev>**. All three are Cloudflare
Workers in this repo, and every custom domain is attached to its Worker in
the Cloudflare dashboard rather than declared in `wrangler.jsonc`, so a
deploy never touches DNS.

The demo is one deployable unit built from the same spec commit: the
generated docs site and the read-only spec MCP server. Anything that can
serve static files and run the stateless streamable-HTTP MCP server can
host it. The server keeps no session state and reads specs from a baked
bundle (`mcp/scripts/bundle-specs.mjs`), so there is no filesystem or
database dependency.

## Cloudflare (implemented, and what this repo's demo runs on)

One Worker (`deploy/cloudflare/`): the docs site as static assets at `/`,
the MCP server at `/mcp` via `nodejs_compat` (the unchanged `node:http`
server behind `httpServerHandler`).

- `cloudflare-deploy.yml` deploys on every main push.
- `cloudflare-preview.yml` uploads a version per PR with a stable
  `pr-<number>` preview alias and comments the URL. The preview is the
  *whole system* (docs + live MCP) at that PR's spec commit.
- Repo secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit) and
  `CLOUDFLARE_ACCOUNT_ID`.

Local run: `task docs:build` with `DOCS_SITE_BASE=/`, then
`npm ci --prefix mcp && node mcp/scripts/bundle-specs.mjs` (the Worker
imports the baked specs bundle), then `npm run dev` in `deploy/cloudflare/`.

## The demo mocks (second Worker)

The mocks (`deploy/cloudflare-mocks/`) serve the same spec-derived bundle
`sysspec mocks serve` serves locally, on Microcks' own URL shapes:
`/rest/<Title>/<version>/...` and `/api/ws/<Title>/<version>/<operation>`,
with the index at `/` listing both. The Worker imports
`cli/src/mock-engine.ts` directly - that module has no node builtins and no
dependencies precisely so workerd can run the one implementation - and
serves a bundle baked at build time by `sysspec mocks bundle`. Nothing is
loaded at runtime, so the deployed mocks are exactly the spec commit they
came from.

- `mocks-deploy.yml` deploys on main pushes touching the specs, the
  examples, the engine or the Worker, then runs `sysspec mocks test`
  against the URL it just deployed. It checks the `workers.dev` hostname
  wrangler prints, not the custom domain: the domain is attached in the
  dashboard, so a gate pointed at it would fail on a Worker that is
  otherwise healthy. Set the repo variable `SYSSPEC_DEMO_MOCKS_URL` to
  check a specific URL instead.
- `mocks-preview.yml` uploads a `pr-<number>` version per PR and holds it
  to that PR's own example suite before commenting the URL. On the very
  first run the Worker does not exist yet, so the job bootstraps it with
  `wrangler deploy` and derives the alias URL (`pr-<n>-sysspec-mocks.<sub>.workers.dev`)
  rather than relying on wrangler to print it, which it does not do on that
  first upload. Both jobs wait for the deployment to answer `/health`
  before running the suite against it.
- Repo secrets: the same `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`.

Event channels publish for as long as a subscriber is connected, which on
Workers needs a Durable Object (`MockEvents`, declared as an SQLite class
so the free plan covers it). REST mocks need no binding at all.

Local run: `npm ci --prefix deploy/cloudflare-mocks`, then
`task mocks:bundle OUT=deploy/cloudflare-mocks/src/generated/mocks-bundle.json`
and `npm run dev` in `deploy/cloudflare-mocks/`. Or skip the Worker
entirely with `task mocks:serve`, which is the same engine on node.

## The sysspec website (third Worker)

The tool's own website ([`website/`](../website/), which documents the
CLI, MCP server, plugin and the spec model rather than rendering a spec
catalog) deploys
as a separate static-assets-only Worker, `sysspec-site`, with the same
pattern: `site-deploy.yml` on main pushes touching `website/`,
`site-preview.yml` for per-PR `pr-<number>` preview aliases, the same two
Cloudflare secrets. The demo and site URLs are committed in
`website/src/lib/links.ts` and `website/astro.config.mjs`; the repo Actions
*variables* `SYSSPEC_DEMO_URL`, `SYSSPEC_DEMO_MCP_URL` and
`SYSSPEC_SITE_URL` stay as overrides for preview deployments that should
point at themselves rather than at production. First deploy: run
`site-deploy.yml` once via workflow_dispatch to bootstrap the Worker the
preview versions target.

Local run: `task site:serve`.

## Hosting the mocks somewhere else

Nothing about the mocks is Cloudflare-specific except the adapter. The
engine ships in the `sysspec` npm package, so any spec repository scaffolded
by `sysspec init` can host its own:

- **Any node host** runs `sysspec mocks serve --host 0.0.0.0 --port $PORT`
  as-is. It is stateless and reads only its own repository.
- **A Worker** (or any fetch-style runtime) bakes a bundle with
  `sysspec mocks bundle --out <file>` and imports `sysspec/mock-engine`
  (the dispatch on its own, with no node builtins) - `deploy/cloudflare-mocks/src/worker.ts` is
  the whole adapter, Durable Object included, and is short enough to copy.
- **A container** wraps the same command; the mocks need no volume, no
  database and no Microcks.
- **GitHub Pages cannot host them.** Pages serves static files, so a repo
  whose docs deploy comes from the scaffolded `pages.yml` publishes its
  catalog there and its mocks on one of the runtimes above.

Whichever host, the gate is the same one this repo runs:
`sysspec mocks test --microcks-url <url> --async-minion-url <url>`.

## AWS (known option, not implemented)

The same two halves map directly:

- **The site** uploads to S3 behind CloudFront, built with
  `DOCS_SITE_BASE=/`. PR previews would be a bucket prefix, a per-PR
  CloudFront Function-routed path, or AWS Amplify Hosting, which has
  built-in PR previews.
- **The MCP server** runs as-is from the published container image
  (`ghcr.io/hungovercoders/sysspec-mcp`, built by `mcp-image.yml`) on App
  Runner, Lambda (with the web adapter), or Fargate. It is a plain
  stateless HTTP server configured by `PORT`/`HOST` env vars, so
  scale-to-zero hosts work.

The mocks are a third unit there, and the same shapes apply: a container
or a Lambda running `sysspec mocks serve`, with the WebSocket channels
needing an ALB or API Gateway WebSocket API rather than a plain function
URL.

The split exists because AWS has no single primitive serving both halves;
on Cloudflare one Worker does. If AWS becomes a real target, mirror
`cloudflare-deploy.yml` with an OIDC role (`aws-actions/configure-aws-credentials`)
instead of an API-token secret.
