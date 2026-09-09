---
title: contracts.lock and .contracts/
description: How an implementation or consumer pins a released contract surface and proves itself against it.
---

Implementation and consumer repos never vendor specs. They pin one
released surface and fetch it read-only on every run — the
[implement/consume journeys](/implement-and-consume/) are built on two
pieces of machinery.

## The lock

Merges to the spec repo's main publish each changed service as a
lightweight git tag `<service>/v<version>`. A consuming repo records one
of those in a `contracts.lock` at its root:

```yaml
# contract pin - version is the spec repo's release tag, sha its commit
version: orders/v3.3.0
sha: 0f6c49430651f7bb5c99efc6a85e8f26cf8ee1f1
```

The **sha, not the tag, is what gets checked out** — a re-cut tag cannot
silently change what you build against. Find both with:

```bash
git ls-remote https://github.com/<owner>/<specs-repo> "refs/tags/orders/v*"
```

## The fetch

A `contracts:fetch` task sparse-checks-out `specs/<service>`, `mocks/` and
`cli/` at the pinned sha into `.contracts/` (gitignored), then
write-protects the specs:

- **Read-only by construction** — every run wipes and re-fetches, so a
  local edit cannot survive, and `chmod a-w` blocks casual ones.
- **The toolchain rides the pin** — the spec repo's `Taskfile.yml` and
  committed CLI bundle come along, so `task -d .contracts mocks:load
  SERVICE=<service>` runs the spec repo's own mock orchestration at the
  pinned version with nothing installed. When this site and your pin
  disagree, `task -d .contracts --list` shows what the pin actually
  provides — follow the pin.

## The verification

`task contracts:verify` is the definition of done, identical locally and
in CI:

1. **Contract tests** — `task -d .contracts contract:test` holds the
   running implementation (its `REST_ENDPOINT`/`ASYNC_ENDPOINT`) to the
   pinned contracts through Microcks.
2. **Strict-bound scenarios** — every pinned feature-file scenario runs
   against the implementation; no pending or unbound steps.
3. **The negative control** — the same suite replayed against the CLI's
   null service (`200 {}` to everything, no events) must fail entirely:
   a suite that stays green against nothing verifies nothing.
4. **Schema fuzz** — for services with an OpenAPI surface, schemathesis
   checks declared-but-unexampled paths still honour the schemas.

Consumers run the same shape against the pinned mocks instead of a real
service — flows against the REST mocks, handlers fed real envelopes,
idempotence on the envelope `id`, and the negative control.

## Staying current

Renovate watches the spec repo's tags and bumps `contracts.lock` like any
other dependency. Additive minors go green and auto-merge; a red run or a
major bump means the surface moved — and only then does convergence work
start, with the failing suite as its scope. The specs never push work at
implementations; they pull.

The full journeys — repo scaffolding, binding rules, CI wiring — live in
the [implement-service and consume-service skills](/plugin-and-skills/).
