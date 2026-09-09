---
title: CLI — sysspec
description: Gates, lint, docs, mocks, contract testing and the init scaffold, as one npm package.
---

The [`sysspec` package](https://www.npmjs.com/package/sysspec) is the CLI
behind every gate and task. In a scaffolded repo you rarely call it directly —
every command is wrapped in a `task` — but the surface is:

```text
usage: sysspec <command> ...

commands:
  check version|compat|intent|surface   diff-based gates against a base ref
  lint manifest|specs|features|datacontracts
  docs data|diagrams
  init <dir> --org <reverse-dns>
  mocks up|down|load|test|watch
  contract test
  null run --results <file> -- <suite command>
```

## Commands

### `check` — diff-based gates

All four compare the working tree against a base ref (`--base`, default
`origin/main`):

- `check version` — any gated artifact change must bump its manifest version
  *and* the service's top-level version; an artifact major forces a service
  major.
- `check compat` — breaking contract changes must carry major bumps.
- `check intent` — every schema element added to an OpenAPI/AsyncAPI
  contract must be named in the service's feature files. No escape hatch
  there; ODCS columns and enum values are covered by the version gate only.
- `check surface` — changes under given paths must bump a named version file
  (how the repo enforces its own package and plugin version bumps).

| Flag | Applies to | Default |
| --- | --- | --- |
| `--base <ref>` | all four | `origin/main` |
| `--specs-dir <dir>` | all four | `specs` |
| `--service <name>` | `compat`, `intent` | all services |
| `--version-file <file>` | `surface` | required |
| `--json-key <key>` | `surface` | `version` (dotted path into the version file) |
| `--paths <a/,b/>` | `surface` | required — comma-separated path prefixes |

A typo'd or unknown flag is an error, never a silent fall-back to a
default.

### `lint`

- `lint specs` — Spectral over the OpenAPI/AsyncAPI contracts, house naming
  rules included.
- `lint features` — gherkin-lint over the acceptance criteria.
- `lint datacontracts` — datacontract-cli over the ODCS files, plus a
  Spectral ruleset for the naming rules.
- `lint manifest` — manifests ⇄ contracts ⇄ spec graph consistency, semver
  versions, feature references resolve to real messages and channels.

All four take `--specs-dir` (default `specs`) and `--service <name>` to
scope to one service.

### `docs`

- `docs data` — emit the spec data the generated docs site renders from.
  Flags: `--specs-dir`, `--site-dir` (default `docs-site`), `--mocks-dir`
  (default `mocks`).
- `docs diagrams` — every mermaid diagram in the generated site must parse.
  Flags: `--specs-dir`, `--docs-dir` (default `docs`), `--site-dir`.

### `init`

`sysspec init <dir> --org <reverse-dns>` scaffolds a complete spec repo:
starter service, Taskfile, mise toolchain, mock stack, docs site, GitHub
workflows, Renovate wiring — green from the first commit. `--sysspec-repo
<owner/repo>` (default `hungovercoders/sysspec`) points the scaffold's
reusable-workflow references at a fork. See
[Getting started](/getting-started/).

### `mocks` and `contract test`

`mocks up|down|load|test|watch` orchestrate the Microcks mock stack from
your contracts; `contract test` holds a real implementation (or, with no
endpoint overrides, the mocks themselves) to the contracts.

| Flag | Applies to | Default |
| --- | --- | --- |
| `--compose-file <file>` | `mocks *` | `mocks/docker-compose.yml`, else the bundled stack |
| `--service <name>` | `load`, `test`, `contract test` | all services |
| `--specs-dir` / `--mocks-dir` | `load`, `test`, `contract test` | `specs` / `mocks` |
| `--microcks-url <url>` | `load`, `test`, `contract test` | `http://localhost:8585` |
| `--async-minion-url <url>` | `load`, `test`, `watch` | `http://localhost:8081` |
| `--channel <Title/version/operation>` | `watch` | required |
| `--rest-endpoint` / `--async-endpoint` | `contract test` | the mocks themselves |

### `null run` — the falsifiability gate

Runs a bound feature suite against a *null service* that proves nothing; the
gate is red unless zero scenarios pass. A suite that goes green against
nothing is hollow, and this catches it.

`null run --results <cucumber-json-file> [--port 9099] [--timeout 300] --
<suite command>` — everything after `--` is the suite command, run with the
null service listening on `--port`.

## Pinned external tools

The CLI fetches its external linters at pinned versions (Spectral,
gherkin-lint, datacontract-cli via uvx, the AsyncAPI CLI, mermaid-cli), so a
scaffolded repo needs only node and mise — see
[`cli/README.md`](https://github.com/hungovercoders/sysspec/blob/main/cli/README.md)
for the development loop.
