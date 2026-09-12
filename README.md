# sysspec

**System specs first.** sysspec is a system spec tool: you write down what
the system is *intended* to do — AsyncAPI, OpenAPI, ODCS data contracts and
Gherkin acceptance criteria — and those specs do double duty:

1. **Context to build from.** Engineers and AI agents read the specs (over
   MCP, at implementation time) instead of guessing from code.
2. **Deterministic gates.** The same specs are packaged and consumed by
   implementations for local and CI testing. They cannot be quietly
   amended to make failing code pass, because they live and version
   separately from every implementation.

This is not documentation of what you have. Specs written next to an
implementation drift toward whatever the code happens to do; sysspec
inverts that. Intent is authored once, versioned deliberately, reached
only through tools, and enforced mechanically — the implementation
conforms to the spec, never the other way round.

This repo is three things at once:

1. **The toolkit** — two npm packages: [`sysspec`](cli/), the CLI
   (gates, lint, docs, mock orchestration for consumers, contract testing
   for implementations, `init` scaffold), and [`sysspec-mcp`](mcp/), the
   MCP server serving stdio locally and streamable HTTP behind a URL.
   One ecosystem end to end; datacontract-cli (the ODCS linter) is
   fetched on demand by uvx.
2. **The distribution** — reusable GitHub workflows
   (`.github/workflows/sysspec-*.yml`) and a Claude Code plugin (MCP tools
   + the three skills).
3. **The living example** — the `orders`/`payments` spec suite, which
   doubles as the toolkit's regression suite: every toolkit change must keep
   it green.

The tool's own website — docs for the CLI, MCP server, plugin and the spec
model — lives in [website/](website/) and deploys to Cloudflare as the
`sysspec-site` Worker, separate from the demo spec catalog
([deploy/README.md](deploy/README.md) covers both).

## Start your own spec suite

```bash
npx -y sysspec init my-specs --org com.acme
cd my-specs
git init
mise install && task setup   # pinned toolchain + the pre-commit hook
git add -A && git commit -m "chore: scaffold specs"   # runs the hook
task ci                      # gates + mock cycle, green from the first commit
```

`mise install` covers the toolchain; the `mocks:*` and `contract:test`
stages additionally need a running Docker daemon (they run the Microcks
stack). Without Docker, `task check` and `task lint` run every other gate.

The scaffold owns only its specs. Everything substantive arrives by
reference and stays current without you copying anything:

| Piece | Reference | Updates via |
| --- | --- | --- |
| Gates, mocks, docs | `sysspec@X` pin in `Taskfile.yml` | Renovate (npm), minor/patch automerge |
| MCP server | `sysspec-mcp@X` pin in `.mcp.json` | Renovate (npm), minor/patch automerge |
| CI / Pages / release tagging | `uses: hungovercoders/sysspec/.github/workflows/sysspec-*.yml@v<major>` | floating major tag |
| Agent skills | Claude Code plugin | `/plugin marketplace update` |

Merges to main publish each changed service as a `<service>/v<version>`
git tag — the release hook the implement/consume journey below pins
against.

## Implement or consume a service

Building against a spec suite is its own journey, in its own repository —
the spec repo stays contracts-only. Install the plugin (see
[below](#use-it-from-another-project)) so the skills and MCP tools are in
your session, then just ask — "implement orders", "build a UI against
payments" — and the matching skill drives the whole loop:

- **`implement-service`** builds the real thing: a new repo that pins a
  released `<service>/v<version>` tag in `contracts.lock`, fetches that
  surface read-only into `.contracts/` (spec repo toolchain included, so
  the Microcks mock stack runs straight from the pin), binds the feature
  files strictly, and proves itself with one command —
  `task contracts:verify` — the same locally and in CI.
- **`consume-service`** builds a consumer — a UI, client, or downstream
  system — against the pinned mocks, before or without the real service
  existing.

Both start with an interview about the things the contract deliberately
leaves open (language, storage, transport), and both end wired for
pull-based sync: new release tags arrive as Renovate pin-bump PRs, green
minors auto-merge untouched, and an agent wakes only when the gates prove
code changes are needed.

The full walkthroughs live in the skills themselves —
[`skills/implement-service/SKILL.md`](skills/implement-service/SKILL.md)
and [`skills/consume-service/SKILL.md`](skills/consume-service/SKILL.md).
They are written to be read as documentation and executed as agent
process: same steps, same commands, whether a human or an agent is
driving.

## The model

A **service** is the unit. It owns artifacts and declares the channels it
produces and consumes, so the spec suite is a graph rather than a folder.

Artifacts come in two classes:

| Class | Kinds | Authority | Editable |
| --- | --- | --- | --- |
| **Gated** | `asyncapi`, `openapi`, `data-contract`, `feature` | Spec of record | Only via versioned change, CI enforced |
| **Ungated** | `doc` | Context and rationale | Freely |

Gherkin sits deliberately in the gated class. Feature files are behavioural
specs, and they are the ones most at risk of being softened to make a
test pass — so they get the same protection as a schema.

Every event is a CloudEvents 1.0 structured envelope with a
`com.<org>.<service>.<event>.v<major>` type; the gates enforce that
breaking changes take majors (`check:compat`) and that every schema
element added to an OpenAPI or AsyncAPI contract is named in the service's
features (`check:intent`, no escape hatch there; ODCS columns and enum
values are covered by the version gate only). `task ci` is the definition
of green — identical locally, in the pre-commit hook, and in CI.

## Layout

```
sysspec/
├── cli/                      sysspec: the CLI and gates (+ init templates), npm
├── mcp/                      sysspec-mcp: the MCP server (stdio + HTTP,
│                             Dockerfile, optional Cloudflare adapter), npm
├── .github/workflows/        sysspec-*.yml reusable; thin local callers
├── skills/                   sysspec, implement-service, consume-service
├── .claude-plugin/           plugin + marketplace manifests
├── .mcp.json                 plugin root, wires server + specs
├── mocks/                    Microcks stack + per-service example files
├── deploy/                   the demo Worker (docs site + MCP), Cloudflare
├── website/                  the sysspec website (tool docs), Cloudflare
└── specs/                    the example: orders, payments
    └── <service>/
        ├── service.yaml      manifest: version, artifacts, produces, consumes
        ├── asyncapi/  openapi/  data-contracts/  features/
```

`service.yaml` is the single source of truth for an artifact's version —
there is no second place to forget to update.

## Tools

| Tool | Use |
| --- | --- |
| `list_services()` | Discovery. Start here. |
| `get_service(name)` | Artifact index + produce/consume edges. No file contents. |
| `get_message_schema(service, message)` | One event payload — the cheap call. |
| `get_acceptance_criteria(service)` | Gherkin, labelled binding. |
| `get_artifact(service, path)` | Any declared artifact, with its authority class. |
| `trace_channel(address)` | Who produces and consumes it — i.e. who you break. |
| `search_specs(query, kind)` | Matching lines, not whole files. |

No write tool exists. Reads are confined to the service directory **and**
to paths the manifest actually declares, so dropping a file into the tree
does not silently expose it.

## Try it

From inside this repo (the dev loop):

```bash
claude --plugin-dir $(pwd)
/mcp                      # confirm the sysspec server started
```

Then ask things like:

- "What fields are on OrderPlaced?"
- "Who consumes payments.settled.v2?"
- "Implement the order placement handler" — it should pull the Gherkin first
- "Change OrderPlaced to drop customer_id" — it should refuse and cite consumers

Requires `node` on PATH (the plugin runs the committed server bundle
directly — no install step).

## Use it from another project

Four ways in, in order of preference.

**1. Install as a plugin from the marketplace (no clone needed).**
Inside any Claude Code session:

```
/plugin marketplace add hungovercoders/sysspec
/plugin install sysspec@hungovercoders
```

You get the MCP tools *and* the skills, available in every project.
To pick up a new version later: `/plugin marketplace update hungovercoders`
then reinstall (or `/reload-plugins` after an auto-update).

**2. Load a local clone as a plugin.** From any project directory:

```bash
claude --plugin-dir /path/to/sysspec
```

Same result as the marketplace install, scoped to that session — useful
when you are iterating on the specs themselves.

**3. Register just the MCP server.** In the consuming project:

```bash
claude mcp add sysspec --scope project \
  --env SPECS_DIR=/path/to/your-specs/specs \
  -- npx -y sysspec-mcp
```

This writes the consuming project's `.mcp.json` (use `--scope user` to
make it global instead). `SPECS_DIR` is the only path the server reads,
so this is also how you point the server at any spec tree. Tools only;
the skills come with the plugin routes above. (Repos scaffolded by
`sysspec init` already carry this wiring, pinned.)

**4. Connect to a hosted URL (no local process at all).** `sysspec-mcp`
also serves streamable HTTP, so the server can be deployed once and shared:

```bash
claude mcp add sysspec --scope project --transport http https://<your-deploy>/mcp
```

Works from clients that can't spawn a local process (remote sessions, CI).
Tools only, like route 3. [mcp/](mcp/README.md) has the Dockerfile, the
GHCR image CI keeps current with this repo's specs, and per-host notes
(any Docker host, Coolify, AWS, Cloudflare) — the deployment is
host-agnostic by design.

Whichever route, verify with `/mcp` and then `list_services()`.

## Contributing and releasing

The gate table, spec change rules, and the `sysspec` release
process live in [CONTRIBUTING.md](CONTRIBUTING.md). Agents: read
[AGENTS.md](AGENTS.md) first.

## License

sysspec is [MIT licensed](LICENSE). Every published artifact carries the
notices for the third-party code it bundles: the `sysspec` and
`sysspec-mcp` npm packages and the MCP container image ship
`THIRD_PARTY_NOTICES.txt` next to their bundles, and the website and every
catalog built from the scaffold serve `third-party-notices.txt` at their
root. The files are generated at build time by
[scripts/third-party-notices.mjs](scripts/third-party-notices.mjs) from
exactly the packages each artifact contains.
