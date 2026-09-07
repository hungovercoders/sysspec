---
title: Implement or consume a service
description: Building against a spec suite is its own journey, in its own repository.
---

Building against a spec suite is its own journey, in its own repository —
the spec repo stays contracts-only. Install the
[plugin](/plugin-and-skills/) so the skills and MCP tools are in your
session, then just ask — "implement orders", "build a UI against payments" —
and the matching skill drives the whole loop.

## implement-service — build the real thing

A new repo that:

1. Pins a released `<service>/v<version>` tag in `contracts.lock`.
2. Fetches that surface read-only into `.contracts/` — spec repo toolchain
   included, so the Microcks mock stack runs straight from the pin.
3. Binds the feature files strictly: each scenario maps to a test, and the
   falsifiability gate (`null run`) proves the suite would go red against a
   service that does nothing.
4. Proves itself with one command — `task contracts:verify` — the same
   locally and in CI.

## consume-service — build against mocks

A consumer — a UI, client, or downstream system — built against the pinned
Microcks mocks, before or without the real service existing. The mocks are
generated from the same gated contracts, so when the real service ships,
the consumer already speaks its language.

## Staying in sync

Both journeys start with an interview about the things the contract
deliberately leaves open (language, storage, transport), and both end wired
for pull-based sync: new release tags arrive as Renovate pin-bump PRs,
green minors auto-merge untouched, and an agent wakes only when the gates
prove code changes are needed. The specs never push work at
implementations.

The full walkthroughs live in the skills themselves —
[`implement-service/SKILL.md`](https://github.com/hungovercoders/sysspec/blob/main/skills/implement-service/SKILL.md)
and
[`consume-service/SKILL.md`](https://github.com/hungovercoders/sysspec/blob/main/skills/consume-service/SKILL.md) —
written to be read as documentation and executed as agent process.
