---
title: Services and artifacts
description: The unit is the service; artifacts are gated or ungated; every change is versioned.
---

A **service** is the unit. It owns artifacts and declares the channels it
produces and consumes, so the spec suite is a graph rather than a folder:

```text
specs/
├── system.yaml          the system these services add up to
└── <service>/
    ├── service.yaml      manifest: version, artifacts, produces, consumes
    ├── asyncapi/  openapi/  data-contracts/  features/
```

`service.yaml` is the single source of truth for an artifact's version —
there is no second place to forget to update.

## The system

One level up sits the suite itself. `specs/system.yaml` says which system
these services belong to — its `title`, the business `domain` it sits in,
and the reverse-DNS `org` every event type is prefixed with:

```yaml
apiVersion: sysspec/v1
kind: System
name: acme-commerce
title: Acme Commerce
domain: Commerce
org: com.acme
summary: >
  What this system is for, in a sentence or two.
```

It is ungated — no versioned change ceremony — but `lint:manifest` holds it
to being complete when present. The generated catalog reads it for its
title, its header badge, its overview annotation and its footer, which is
what makes one instance's site recognisably its own. `sysspec init` seeds it
from `--org`, `--system` and `--domain`; a suite without the file still
renders, generically.

## Two classes of artifact

| Class | Kinds | Authority | Editable |
| --- | --- | --- | --- |
| **Gated** | `asyncapi`, `openapi`, `data-contract`, `feature` | Spec of record | Only via versioned change, CI enforced |
| **Ungated** | `doc` | Context and rationale | Freely |

Gherkin sits deliberately in the gated class. Feature files are behavioural
specs, and they are the ones most at risk of being softened to make a test
pass — so they get the same protection as a schema. If an implementation
disagrees with a gated artifact, the implementation is wrong; adjusting the
artifact is always a finding, not a fix.

## Versioned change

When you change a gated artifact deliberately:

1. Bump the artifact's version in `specs/<service>/service.yaml` (and
   `info.version` in the spec — they must match).
2. Bump the service's top-level `version:`. Breaking change ⇒ major on both.
3. If you added a schema element, name it in a scenario in that service's
   `features/` — `check:intent` fails otherwise, deliberately without an
   escape hatch.

Every event is a CloudEvents 1.0 structured envelope with a
`com.<org>.<service>.<event>.v<major>` type; the gates enforce that breaking
changes take majors (`check:compat`) and that every added schema element is
named in the service's features (`check:intent`).

On merge to main, each changed service is published as a lightweight git tag
`<service>/v<version>`. Implementation and consumer repos pin those tags via
a `contracts.lock` and pull updates through Renovate — the specs never push
work at them.

See [Gates and CI](/gates-and-ci/) for how each rule is enforced, and
[Conventions](/conventions/) for the house rules the linters apply.
