---
title: Mock example files
description: The Microcks APIExamples fixtures that make the mocks answer — format, matching rules, and dispatch limits.
---

The gated specs carry no example payloads — fixtures live beside them in
`mocks/*.examples.yaml` (Microcks `APIExamples` documents), uploaded as
secondary artifacts by `task mocks:load`. One file per service and surface:
`<service>.rest.examples.yaml`, `<service>.events.examples.yaml`.

## The matching rule that bites

`metadata.name` and `metadata.version` **must match the spec's
`info.title` and `info.version`** — Microcks joins examples to services on
that pair, so a mismatched upload silently lands on the wrong (or a
phantom) service. `lint:manifest` keeps the spec side honest
(`info.version` equals the manifest artifact version), which is why a spec
version bump moves the examples file in the same commit.

## REST cases

```yaml
apiVersion: mocks.microcks.io/v1alpha1
kind: APIExamples
metadata:
  name: Orders API      # == info.title
  version: 3.2.0        # == info.version
operations:
  'POST /orders':
    placed:
      request:
        headers: { Content-Type: application/json }
        body: |-
          { "customer_id": "…", "lines": [ … ] }
      response:
        status: "201"          # quoted - Microcks wants a string
        mediaType: application/json
        body: |-
          { "order_id": "…", "status": "placed", "total_pence": 2500 }
```

- Path parameters go under `request.parameters` and fill `{placeholders}`
  in the operation key; leftover parameters become query string.
- `status` is a **quoted string**; bodies use a `body:` key (block scalar).
- The smoke test (`task mocks:test`) replays every case against the mock
  and structurally matches the response body; values containing `{{ }}`
  templating are not asserted.

## Event cases

Event messages use `eventMessage` with the CloudEvents envelope as the
payload:

```yaml
operations:
  'SEND publishOrderPlaced':
    placed:
      eventMessage:
        payload: |-
          { "specversion": "1.0", "id": "…", "type": "…", "data": { … } }
```

The async minion publishes each example on its channel every few seconds —
that ambient stream is what consumers build against.

## Dispatch limits for error cases

Error examples dispatch by URI, not body. A path-parameterized GET can
carry a happy and an error case side by side (distinct parameter values
dispatch to distinct responses — this is how the orders `404` example
works). POST error cases (e.g. a `400` for an invalid body) would need a
body-aware dispatcher on the operation to coexist with the happy-path
example, so the smoke suite replays error surfaces only where URI dispatch
reaches them.

## Where they end up

- REST mocks: `http://localhost:8585/rest/<info.title>/<version>/…`
  (spaces in the title become `+`).
- Event channels: `ws://localhost:8081/api/ws/<info.title>/<version>/<operation>`.
- Implementations replay the same REST cases **verbatim against the real
  service** in `contract test` — the example fixtures are contract, not
  decoration.
