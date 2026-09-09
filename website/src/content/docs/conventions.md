---
title: Conventions
description: The house rules every spec suite follows — enforced by the linters, not advisory.
---

These conventions come from the `sysspec` skill
([`skills/sysspec/SKILL.md`](https://github.com/hungovercoders/sysspec/blob/main/skills/sysspec/SKILL.md)),
which agents load when working against specs. They are enforced by the
linters (`lint:specs`, `lint:datacontracts`, `lint:manifest`), not advisory.

## Naming

- **Attributes and their values are `lower_snake_case`** — every payload
  property, schema property, path and query parameter, ODCS column, and
  enumerated value (`out_of_stock`, not `outOfStock`). A field is spelled the
  same in the AsyncAPI payload, the OpenAPI schema and the data contract, so
  no consumer translates between them. Spectral rules enforce this across
  the specs and the ODCS files.
- **Header parameters are the one exception**: they keep canonical HTTP
  casing (`Idempotency-Key`, not `idempotency_key`) — HTTP header names
  are case-insensitive hyphenated identifiers, not payload attributes, and
  the Spectral snake_case rule is deliberately scoped to path and query
  parameters only.
- Document-local identifiers keep their own conventions: message names
  `PascalCase` and past tense (`OrderPlaced`, `PaymentSettled`), channel and
  operation keys and OpenAPI `operationId`s `camelCase`, channel addresses
  dotted lowercase.
- Channel addresses: `<service>.<event>.v<major>`, lowercase, dot separated
  (`orders.placed.v2`). The major version lives in the address; minor changes
  never change it.

## Events

- Every event is a CloudEvents 1.0 **structured** envelope
  (`application/cloudevents+json`): `specversion` `"1.0"`, `id` (uuid),
  `source` (`/<service>`), `type` (`com.<org>.<service>.<event>.v<major>`,
  reverse-DNS org, matching the channel major), `subject` (the aggregate id),
  `time`, `datacontenttype`, and the domain payload under `data`. Envelope
  and `data` both set `additionalProperties: false` and an explicit
  `required`.
- Delivery is at-least-once; handlers dedupe on the envelope `id`. The
  natural key in `data` (`order_id`, `payment_id`) identifies the aggregate,
  not the event.
- Ordering holds only within a partition key (the aggregate id), never
  across channels.
- AsyncAPI channels carry a `ws` binding (the mock transport) and every
  operation lists explicit `messages` refs — the Microcks async runner
  cannot validate without them.

## Values

- Money is an integer in minor units, suffixed `_pence`. Never a float.
- Identifiers are `format: uuid`. Timestamps `format: date-time`, UTC.

## Versions

- Spec `info.version` always equals the manifest version — mock URLs and
  rendered docs surface `info.version`, and `lint:manifest` enforces the
  match.
- Every manifest carries a top-level `version:` — the version of the
  service's whole contract surface, which is what consumers pin. Any gated
  artifact bump bumps it; a breaking change bumps its major.
- Merges to main publish each changed service's contract surface as a
  lightweight tag `<service>/v<version>`.

## Intent

Every schema element you add to an OpenAPI or AsyncAPI contract — message,
payload property, endpoint, parameter — must be named in that service's
feature files. The feature change is part of the contract change, not an
afterthought; `check:intent` enforces this with no escape hatch there
(ODCS columns and enum values are covered by the version gate only). If it
is not worth a scenario, it is not worth adding to the contract yet.
