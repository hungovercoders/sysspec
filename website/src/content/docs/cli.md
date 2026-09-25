---
title: CLI (sysspec)
description: Gates, lint, docs, mocks, contract testing and the init scaffold, as one npm package.
---

The [`sysspec` package](https://www.npmjs.com/package/sysspec) is the CLI
behind every gate and task. In a scaffolded repo you rarely call it
directly, because every command is wrapped in a `task`, but the surface is:

```text
usage: sysspec <command> ...

commands:
  check version|compat|intent|surface   diff-based gates against a base ref
  lint manifest|specs|features|datacontracts
  docs data|diagrams
  init <dir> --org <reverse-dns> [--system <title>] [--domain <name>]
  mocks up|down|load|test|watch
  contract test
  null run --results <file> -- <suite command>
```

## Commands

### The `check` gates

All four compare the working tree against a base ref (`--base`, default
`origin/main`).

- `check version` fails unless a gated artifact change bumps its manifest
  version *and* the service's top-level version; an artifact major forces a
  service major. Versions only go up (see below).
- `check compat` fails when a breaking contract change does not carry a
  major bump.
- `check intent` requires every schema element added to an OpenAPI/AsyncAPI
  contract to be named in the service's feature files. There is no escape
  hatch, and ODCS columns and enum values count.
- `check surface` requires changes under given paths to bump a named
  version file, which is how the repo enforces its own package and plugin
  version bumps.

| Flag | Applies to | Default |
| --- | --- | --- |
| `--base <ref>` | all four | `origin/main` |
| `--specs-dir <dir>` | all four | `specs` |
| `--service <name>` | `compat`, `intent` | all services |
| `--version-file <file>` | `surface` | required |
| `--json-key <key>` | `surface` | `version` (dotted path into the version file) |
| `--paths <a/,b/>` | `surface` | required, comma-separated path prefixes |
| `--allow-missing-base` | all four | off |

A typo'd or unknown flag is an error, never a silent fall-back to a
default.

When the gates find no merge-base with the base ref, they work out why:

- Not inside a git work tree at all: they fail, since nothing can be
  diffed.
- `HEAD` has no commits yet (the first commit in a new repo): there is
  no history to compare, so they skip.
- The ref exists but shares no history with `HEAD`. The history is cut
  short (a shallow clone) or unrelated, so the gates fail wherever they
  run and suggest `git fetch --unshallow`.
- The ref does not exist. In a fresh repo with no remote yet there is
  honestly nothing to compare, so locally the gates say so and skip. In
  CI (the `CI` environment variable set to anything but `false` or `0`)
  or in a shallow clone, a missing base almost always means it was never
  fetched, so the gates fail rather than pass without checking anything.

Check out with `fetch-depth: 0`, as the reusable workflows do, or pass
`--allow-missing-base` (or set `SYSSPEC_ALLOW_MISSING_BASE=1`) where
skipping really is what you want. The reusable `sysspec-ci.yml` sets
`SYSSPEC_BASE` to the pull request's base branch, or on a push to the
repository's default branch, and the scaffolded Taskfile diffs against
it, so a repository whose default branch is not `main` works as is. The
workflow's `allow-missing-base` input sets the variable above.

Versions only go up. `check version` and `check surface` order versions
the same way: semver precedence when both sides are semver (a
pre-release promoted to its release, `2.0.0-rc.1` to `2.0.0`, is a
bump), otherwise PEP 440-style (`1.2` < `1.3`, `1.2.3rc1` < `1.2.3` <
`1.2.3.post1`). Every declared version is checked whether or not its file
changed:

- A downgrade fails, and so does a version that disappears.
- The same version respelled (`1.0.0` to `v1.0.0`, `1.2` to `1.2.0`) or
  differing only in build metadata is harmless on an untouched artifact,
  but it is not the bump a changed artifact (or `check surface`) needs.
- A change between versions neither rule can rank (`latest`, say) is
  accepted with a note.

### `lint`

- `lint specs` runs Spectral over the OpenAPI/AsyncAPI contracts, house
  naming rules included.
- `lint features` runs gherkin-lint over the acceptance criteria.
- `lint datacontracts` runs the vendored ODCS 3.2 JSON Schema and
  datacontract-cli over the ODCS files, plus a Spectral ruleset for the
  naming rules.
- `lint manifest` checks manifests ⇄ contracts ⇄ spec graph consistency,
  semver versions, and that feature references resolve to real messages and
  channels.

All four take `--specs-dir` (default `specs`) and `--service <name>` to
scope to one service.

### `docs`

- `docs data` emits the spec data the generated docs site renders from.
  Flags: `--specs-dir`, `--site-dir` (default `docs-site`), `--mocks-dir`
  (default `mocks`).
- `docs diagrams` parses every mermaid diagram in the generated site.
  Flags: `--specs-dir`, `--docs-dir` (default `docs`), `--site-dir`.

### `init`

`sysspec init <dir> --org <reverse-dns>` scaffolds a complete spec repo:
starter service, `specs/system.yaml`, Taskfile, mise toolchain, mock stack,
docs site, GitHub workflows and Renovate wiring, green from the first
commit.

| Flag | Default | Effect |
| --- | --- | --- |
| `--org <reverse-dns>` | required | The event-type namespace (`com.acme.greeter.greeted.v1`), recorded in `specs/system.yaml`. |
| `--system <title>` | the org's last label, title-cased | The system's name, used for the generated catalog's title, header and footer. |
| `--domain <name>` | `Examples` | The business domain the system sits in, shown beside its name. |
| `--sysspec-repo <owner/repo>` | `hungovercoders/sysspec` | Points the scaffold's reusable-workflow references at a fork. |

`--system` and `--domain` are what make one catalog recognisably its own
rather than a generic "System specs"; both land in `specs/system.yaml` and
can be edited there afterwards. See [Getting started](/getting-started/).

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

### The falsifiability gate (`null run`)

Runs a bound feature suite against a *null service* that proves nothing; the
gate is red unless zero scenarios pass. A suite that goes green against
nothing is hollow, and this catches it.

Everything after `--` in
`null run --results <cucumber-json-file> [--port 9099] [--timeout 300] --
<suite command>` is the suite command, run with the null service listening
on `--port`.

## Pinned external tools

The CLI fetches its external linters at pinned versions (Spectral,
gherkin-lint, datacontract-cli via uvx, the AsyncAPI CLI, mermaid-cli), so a
scaffolded repo needs only node and mise. See
[`cli/README.md`](https://github.com/hungovercoders/sysspec/blob/main/cli/README.md)
for the development loop.
