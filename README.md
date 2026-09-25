# sysspec

**System specs first.** sysspec is a system spec tool: you write down what
the system is *intended* to do (AsyncAPI, OpenAPI, ODCS data contracts and
Gherkin acceptance criteria), and those specs then do three jobs:

1. **Context to build from.** Engineers and AI agents read the specs (over
   MCP, at implementation time) instead of guessing from code.
2. **A domain expert anyone can interrogate.** The same MCP tools answer
   plain-language questions about what a service is for, what an event
   carries and who breaks if it changes, so product, analysts, architects,
   support and new joiners get the system's intent without opening a file.
3. **Deterministic gates.** The same specs are packaged and consumed by
   implementations for local and CI testing. They cannot be quietly
   amended to make failing code pass, because they live and version
   separately from every implementation.

Specs written next to an implementation drift toward whatever the code
happens to do. sysspec works the other way round. Intent is authored once,
versioned deliberately and reached only through tools, and the gates hold
the implementation to it rather than the reverse.

The repo holds three things.

1. **The toolkit.** Two npm packages. [`sysspec`](cli/) is the CLI (gates,
   lint, docs, mock orchestration for consumers, contract testing for
   implementations, `init` scaffold), and [`sysspec-mcp`](mcp/) is the MCP
   server, serving stdio locally and streamable HTTP behind a URL. ODCS
   files are held to the standard's own JSON Schema (ODCS 3.2, vendored)
   and to datacontract-cli, fetched on demand by uvx.
2. **The distribution.** Reusable GitHub workflows
   (`.github/workflows/sysspec-*.yml`) and a Claude Code plugin carrying
   the MCP tools and the three skills.
3. **The living example.** **sysspec demo** is the `orders`/`payments`
   spec suite that `specs/system.yaml` names, and it doubles as the
   toolkit's regression suite, so every toolkit change has to keep it
   green. It is published as a live catalog at
   **<https://demo.sysspec.dev>**, with its MCP endpoint at `/mcp`.

Docs for the tool itself (CLI, MCP server, plugin and the spec model) live
at **<https://sysspec.dev>** (source in [website/](website/)) and deploy to
Cloudflare as the `sysspec-site` Worker, separate from the demo spec
catalog. [deploy/README.md](deploy/README.md) covers both.

## Start your own spec suite

```bash
npx -y sysspec init my-specs --org com.acme \
  --system "Acme Commerce" --domain Commerce
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
git tag, which is the release hook the implement/consume journey below
pins against.

## Ask the specs

Before anyone builds anything, the suite is already useful: connect an MCP
client and ask about the system in plain language. The example suite is
served publicly, so this works right now:

```bash
claude mcp add sysspec --scope project \
  --transport http https://demo.sysspec.dev/mcp
```

Then ask in your own words:

- "Who consumes `orders.placed.v2`?"
- "What does a customer have to supply to place an order?"
- "If we dropped `customer_id` from `OrderPlaced`, who breaks, and is that
  a major?"
- "Where is 'settled' defined, and does payments mean the same by it as
  orders?"

Answers come from the specs of record. They are versioned, gated, and the
same surface implementations are held to, so nobody is relying on memory
or on code that may have drifted. That makes the suite worth having for
people who will never open the repo.

Point it at your own specs with `SPECS_DIR` (route 3 below), or host the
endpoint once and record it in `specs/system.yaml`:

```yaml
mcp: https://specs.example.com/mcp
```

Every generated catalog then carries an **Ask these specs** page with that
URL and starter questions drawn from your own services, events and
scenarios. The full story: <https://sysspec.dev/ask-the-specs/>.

## Implement or consume a service

Building against a spec suite happens in its own repository; the spec repo
stays contracts-only. Install the plugin (see
[below](#use-it-from-another-project)) so the skills and MCP tools are in
your session, then ask for what you want ("implement orders", "build a UI
against payments") and the matching skill drives the loop:

- **`implement-service`** builds the real thing: a new repo that pins a
  released `<service>/v<version>` tag in `contracts.lock`, fetches that
  surface read-only into `.contracts/` (spec repo toolchain included, so
  the Microcks mock stack runs straight from the pin), binds the feature
  files strictly, and proves itself with one command,
  `task contracts:verify`, the same locally and in CI.
- **`consume-service`** builds a consumer (a UI, client, or downstream
  system) against the pinned mocks, before or without the real service
  existing.

Both start by asking about the things the contract leaves open (language,
storage, transport), and both end wired for pull-based sync, so new
release tags arrive as Renovate pin-bump PRs, green minors auto-merge
untouched, and an agent only gets involved when the gates show code
changes are needed.

The full walkthroughs live in the skills themselves,
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

Gherkin sits in the gated class on purpose. Feature files are behavioural
specs, and they are the ones most at risk of being softened to make a
test pass, so they get the same protection as a schema.

Every event is a CloudEvents 1.0 structured envelope with a
`com.<org>.<service>.<event>.v<major>` type. The gates enforce that
breaking changes take majors (`check:compat`) and that every schema
element added to a contract is named in the service's features
(`check:intent`, with no escape hatch), ODCS columns and enum values
included, now that ODCS 3.2 makes every allowed value a first-class
entry. `task ci` is the definition of green, and it runs identically
locally and in CI. The git hooks run faster tiers of it: lint and the
version gates before each commit, and the test suites and builds before
each push.

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
    ├── system.yaml           the system these specs describe: title,
    │                         domain, event namespace, MCP endpoint - the
    │                         catalog's annotation, unique to each suite
    └── <service>/
        ├── service.yaml      manifest: version, artifacts, produces, consumes
        ├── asyncapi/  openapi/  data-contracts/  features/
```

`service.yaml` is the single source of truth for an artifact's version, so
there is no second place to forget to update.

## Tools

Seven read-only tools, the same ones behind both uses above:

| Tool | Use |
| --- | --- |
| `list_services()` | Discovery. Start here. |
| `get_service(name)` | Artifact index + produce/consume edges. No file contents. |
| `get_message_schema(service, message)` | One event payload, the cheap call. |
| `get_acceptance_criteria(service)` | Gherkin, labelled binding. |
| `get_artifact(service, path)` | Any declared artifact, with its authority class. |
| `trace_channel(address)` | Who produces and consumes it, i.e. who you break. |
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
- Ask it to implement the order placement handler, and it should pull the
  Gherkin first
- Ask it to drop `customer_id` from OrderPlaced, and it should refuse and
  cite the consumers

Requires `node` on PATH (the plugin runs the committed server bundle
directly, so there is no install step).

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

Same result as the marketplace install, scoped to that session. Useful
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
GHCR image CI keeps current with this repo's specs, and notes for
individual hosts (any Docker host, Coolify, AWS, Cloudflare); the
deployment is host-agnostic.

Whichever route, verify with `/mcp` and then `list_services()`.

## Contributing and releasing

The gate table, spec change rules, and the `sysspec` release
process live in [CONTRIBUTING.md](CONTRIBUTING.md). Agents: read
[AGENTS.md](AGENTS.md) first.
