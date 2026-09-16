---
title: Getting started
description: Scaffold a spec suite that is green from the first commit.
---

Start a spec suite of your own:

```bash
npx -y sysspec init my-specs --org com.acme \
  --system "Acme Commerce" --domain Commerce
cd my-specs
git init
mise install && task setup   # pinned toolchain + the pre-commit hook
git add -A && git commit -m "chore: scaffold specs"   # runs the hook
task ci                      # gates + mock cycle, green from the first commit
```

`mise install` covers the toolchain; the mock cycle (`contract:test`,
`mocks:test`) additionally needs a running Docker daemon. Without Docker,
`task check` and `task lint` run every other gate.

The scaffold owns only its specs. Everything substantive arrives by
reference and stays current without you copying anything:

| Piece | Reference | Updates via |
| --- | --- | --- |
| Gates, mocks, docs | `sysspec@X` pin in `Taskfile.yml` | Renovate (npm), minor/patch automerge |
| MCP server | `sysspec-mcp@X` pin in `.mcp.json` | Renovate (npm), minor/patch automerge |
| CI / Pages / release tagging | `uses: hungovercoders/sysspec/.github/workflows/sysspec-*.yml@v<major>` | floating major tag |
| Agent skills | Claude Code plugin | `/plugin marketplace update` |

Merges to main publish each changed service as a `<service>/v<version>` git
tag, which is the release hook the
[implement/consume journeys](/implement-and-consume/) pin against.

## What you get

- A `specs/` tree with a starter service (manifest, AsyncAPI contract and
  feature file) that already passes every gate. Swap it for your first real
  service.
- A `specs/system.yaml` naming the system those services add up to: its
  title, business domain, event namespace and (optionally) the `mcp:`
  endpoint your specs are served on. It annotates every page of your
  catalog, so the site is unmistakably yours rather than a generic
  "System specs". `--system` and `--domain` seed it, and you edit it in
  place from there.
- A generated docs site (Astro/Starlight) rendering your services, contracts
  and system graph, deployable to GitHub Pages out of the box. It carries
  an **Ask these specs** page: how to connect an MCP client, plus starter
  questions drawn from your own services, events and scenarios, so
  colleagues who will never open the repo can still
  [interrogate it](/ask-the-specs/).
- The Microcks mock stack, loaded from your contracts, so consumers can build
  against mocks before any implementation exists.
- Renovate wiring, so toolkit updates arrive as pin-bump PRs and green minors
  auto-merge.

## Where to next

- Understand [the model](/model/): services, gated artifacts, versioned change.
- Learn the [authoring conventions](/conventions/) the linters enforce.
- [Ask your specs questions](/ask-the-specs/), which is the fastest payback
  and not only for agents.
- Point an agent at your specs with the [MCP server](/mcp/) or the
  [Claude Code plugin](/plugin-and-skills/).
