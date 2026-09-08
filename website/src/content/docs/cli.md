---
title: CLI — sysspec
description: Gates, lint, docs, mocks, contract testing and the init scaffold, as one npm package.
---

The [`sysspec` package](https://www.npmjs.com/package/sysspec) is the CLI
behind every gate and task. In a scaffolded repo you rarely call it directly —
every command is wrapped in a `task` — but the surface is:

```
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
- `check intent` — every added schema element must be named in the service's
  feature files. No escape hatch.
- `check surface` — changes under given paths must bump a named version file
  (how the repo enforces its own package and plugin version bumps).

### `lint`

- `lint specs` — Spectral over the OpenAPI/AsyncAPI contracts, house naming
  rules included.
- `lint features` — gherkin-lint over the acceptance criteria.
- `lint datacontracts` — datacontract-cli over the ODCS files, plus a
  Spectral ruleset for the naming rules.
- `lint manifest` — manifests ⇄ contracts ⇄ spec graph consistency, semver
  versions, feature references resolve to real messages and channels.

### `docs`

- `docs data` — emit the spec data the generated docs site renders from.
- `docs diagrams` — every mermaid diagram in the generated site must parse.

### `init`

`sysspec init <dir> --org <reverse-dns>` scaffolds a complete spec repo:
example service, Taskfile, mise toolchain, mock stack, docs site, GitHub
workflows, Renovate wiring — green from the first commit. See
[Getting started](/getting-started/).

### `mocks` and `contract test`

`mocks up|down|load|test|watch` orchestrate the Microcks mock stack from
your contracts; `contract test` holds a real implementation (or, with no
endpoint overrides, the mocks themselves) to the contracts.

### `null run` — the falsifiability gate

Runs a bound feature suite against a *null service* that proves nothing; the
gate is red unless zero scenarios pass. A suite that goes green against
nothing is hollow, and this catches it.

## Pinned external tools

The CLI fetches its external linters at pinned versions (Spectral,
gherkin-lint, datacontract-cli via uvx, the AsyncAPI CLI, mermaid-cli), so a
scaffolded repo needs only node and mise — see
[`cli/README.md`](https://github.com/hungovercoders/sysspec/blob/main/cli/README.md)
for the development loop.
