# sysspec-mcp

Read-only MCP access to a sysspec spec tree: AsyncAPI, OpenAPI, ODCS data
contracts and Gherkin acceptance criteria, served as seven narrow tools
(`list_services`, `get_service`, `get_artifact`, `get_message_schema`,
`get_acceptance_criteria`, `trace_channel`, `search_specs`). One
TypeScript implementation behind every route in: stdio for local clients,
stateless streamable HTTP for a hosted URL. There is no write tool, and
reads are confined to artifacts a service manifest declares.

The server is a generic engine — the specs are per-repo data, pointed at
with `SPECS_DIR`.

## Run it locally

```bash
# stdio (what .mcp.json and the Claude plugin wire up)
SPECS_DIR=./specs npx -y sysspec-mcp

# streamable HTTP on a port
SPECS_DIR=./specs npx -y sysspec-mcp --transport http --host 0.0.0.0 --port 8080
```

Env equivalents (container-friendly): `SYSSPEC_MCP_TRANSPORT`, `HOST`,
`PORT`, `SYSSPEC_MCP_PATH`, `SYSSPEC_MCP_ALLOWED_HOSTS`. See `--help`.
HTTP mode is stateless — no session affinity needed, so it works behind
any load balancer or scale-to-zero platform. The MCP endpoint is `/mcp`;
`/` answers with a small info document.

## Serve it over a URL

The [Dockerfile](Dockerfile) packages the server with this repo's specs.
Build from the repo root:

```bash
docker build -f mcp/Dockerfile -t sysspec-mcp .
docker run --rm -p 8080:8080 sysspec-mcp
```

CI pushes this image to `ghcr.io/hungovercoders/sysspec-mcp`
(`:latest` and `:<commit sha>`) on every push to main, using only the
built-in `GITHUB_TOKEN` — so the image stays current with the specs
without any host being wired into the repo. Deployment is then just
pointing a host at the image; nothing here depends on which one:

- **Any Docker host / VPS / Coolify** — deploy the GHCR image, or point
  Coolify at this repo with `mcp/Dockerfile` as the Dockerfile (build
  context: repo root) for build-on-push.
- **AWS** — App Runner or ECS pulling `ghcr.io/hungovercoders/sysspec-mcp`,
  port 8080.
- **Cloudflare** — Containers can run the same image (paid plan), or use
  the optional free-tier Worker adapter:
  `cd mcp && npx wrangler deploy --config adapters/cloudflare/wrangler.jsonc`
  ([adapters/cloudflare/](adapters/cloudflare/) — a thin fetch entry over
  the same server, specs bundled at deploy time; nothing else depends on
  it).

Connect a client to whichever URL results:

```bash
claude mcp add sysspec --scope project --transport http https://<your-deploy>/mcp
```

## Hardening

The tools are read-only and confined to declared artifacts, so the blast
radius of an open endpoint is "someone reads the specs". If the specs are
not public:

- put an authenticating proxy (Cloudflare Access, an ALB with OIDC, ...)
  in front of the URL;
- set `SYSSPEC_MCP_ALLOWED_HOSTS=mcp.example.com` to reject requests
  carrying any other Host header (DNS-rebinding protection).

## Development

```bash
cd mcp
npm install
npm test            # tool contract (fs + bundled sources), stdio + http e2e
npm run build       # dist/ — committed, the plugin runs it directly
```

`dist/stdio.mjs` is a dependency-free bundle committed to the repo so the
Claude plugin can run the server from a marketplace checkout with nothing
but node. `task check:mcp:dist` fails CI when it is stale — rebuild and
commit after changing `src/`.

Behavioral contract notes live in `src/core.ts`; the test suite in
`test/tools.test.ts` is a line-for-line port of the original Python
server's suite and runs against this repo's real `specs/` tree.
