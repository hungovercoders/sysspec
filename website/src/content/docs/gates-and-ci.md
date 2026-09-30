---
title: Gates and CI
description: task ci is the definition of green, identical locally and in CI, with faster tiers in the git hooks.
---

Everything runs through [Task](https://taskfile.dev). If a command is not a
`task`, it is not part of the workflow. The checks are identical locally
and in CI, and the git hooks run tiers of the same tasks: `task check:fast`
(lint and the diff gates) before each commit, and `task lint check` (adding
the docs build) before each push. The full run is:

```bash
task ci
```

In a spec repo it composes, in order:

| Task | What it enforces |
| --- | --- |
| `lint:specs` | Spectral over the OpenAPI/AsyncAPI contracts, house naming rules included |
| `lint:features` | gherkin-lint over the acceptance criteria |
| `lint:datacontracts` | the ODCS 3.2 JSON Schema (vendored, strict), then datacontract-cli, then Spectral for naming |
| `lint:manifest` | manifests ⇄ contracts ⇄ spec graph consistency, semver versions, feature references resolve to real messages and channels, and `specs/system.yaml` is complete when present |
| `check:version` | any gated artifact change bumps its manifest version *and* the service's top-level version; artifact major ⇒ service major |
| `check:compat` | breaking contract changes carry major bumps (artifact and service) |
| `check:intent` | every schema element added to a contract is named in the service's feature files, with no escape hatch; ODCS columns and enum values included |
| `docs:build` | the generated docs site builds `--strict` |
| `docs:diagrams` | every mermaid diagram in the generated site parses |
| `contract:test` / `mocks:test` | Microcks mocks load, contract-test, and smoke-test green (needs a running Docker daemon) |

Scope most tasks to one service with `SERVICE=<name>`.

The falsifiability gate (`sysspec null run`) belongs to the
[implement/consume journeys](/implement-and-consume/) rather than a spec
repo's `task ci`: an implementation's bound suite must fail entirely
against a service that proves nothing before its green means anything.

## A red gate is information

Gated artifacts are the spec of record. Never edit one to make an
implementation, a check, or a test pass; that direction is a finding, not
a fix. Changing one deliberately is a versioned act with its
own gates ([the model](/model/) walks through it).

## Reusable workflows

Scaffolded repos don't copy CI, they reference it. The sysspec repo
publishes reusable GitHub workflows, pinned by floating major tag:

```yaml
uses: hungovercoders/sysspec/.github/workflows/sysspec-ci.yml@v0
```

| Workflow | What it does |
| --- | --- |
| `sysspec-ci.yml` | checkout, pinned toolchain via mise, `task ci` |
| `sysspec-pages.yml` | build the generated docs site and deploy to GitHub Pages |
| `sysspec-release-tags.yml` | on merge to main, tag each changed service `<service>/v<version>` |
| `sysspec-mcp-image.yml` | build and push a Docker image of the MCP server with your specs |

`sysspec init` wires the first three up for you; updates arrive by moving
the major tag, never by editing your repo.
