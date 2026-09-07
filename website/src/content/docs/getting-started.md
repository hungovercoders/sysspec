---
title: Getting started
description: Scaffold a spec suite that is green from the first commit.
---

Start a spec suite of your own:

```bash
npx -y sysspec init my-specs --org com.acme
cd my-specs
git init && git add -A && git commit -m "chore: scaffold specs"
mise install
task ci        # gates + mock cycle, green from the first commit
```

The scaffold owns only its specs. Everything substantive arrives by
reference and stays current without you copying anything:

| Piece | Reference | Updates via |
| --- | --- | --- |
| Gates, mocks, docs | `sysspec@X` pin in `Taskfile.yml` | Renovate (npm), minor/patch automerge |
| MCP server | `sysspec-mcp@X` pin in `.mcp.json` | Renovate (npm), minor/patch automerge |
| CI / Pages / release tagging | `uses: hungovercoders/sysspec/.github/workflows/sysspec-*.yml@v<major>` | floating major tag |
| Agent skills | Claude Code plugin | `/plugin marketplace update` |

Merges to main publish each changed service as a `<service>/v<version>` git
tag — the release hook the [implement/consume journeys](/implement-and-consume/)
pin against.

## What you get

- A `specs/` tree with an example service (manifest, AsyncAPI, OpenAPI, data
  contract, feature file) that already passes every gate.
- A generated docs site (Astro/Starlight) rendering your services, contracts
  and system graph — deployable to GitHub Pages out of the box.
- The Microcks mock stack, loaded from your contracts, so consumers can build
  against mocks before any implementation exists.
- Renovate wiring, so toolkit updates arrive as pin-bump PRs and green minors
  auto-merge.

## Where to next

- Understand [the model](/model/) — services, gated artifacts, versioned change.
- Learn the [authoring conventions](/conventions/) the linters enforce.
- Point an agent at your specs with the [MCP server](/mcp/) or the
  [Claude Code plugin](/plugin-and-skills/).
