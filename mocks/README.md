# Mocks

Every specified service is mocked from its contracts and its example
artifacts: REST mocks from the OpenAPI contracts, ambient WebSocket events
from the AsyncAPI contracts. Two engines serve them, and they answer the
same example suite.

```sh
task mocks:load             # Microcks: start the stack and load all services
task mocks:test             # smoke-test the Microcks mocks
task mocks:serve            # the same mocks, no Docker, on :8686
task mocks:parity           # the suite, run against the served mocks
task mocks:load SERVICE=orders
```

REST mocks: `http://localhost:8585/rest/<info.title>/<version>/...` (spaces
in the title become `+`). Event channels:
`ws://localhost:8081/api/ws/<info.title>/<version>/<operationName>`.

## The served mocks (`mocks serve`)

`sysspec mocks serve` reads the specs and the example artifacts directly
and answers on Microcks' own URL shapes, with no stack to start and no
state to load. It exists for two reasons: developing a consumer without
Docker, and hosting the mocks somewhere - `sysspec mocks bundle` bakes the
same data into a JSON file a Worker or any other runtime serves (see
[deploy/README.md](../deploy/README.md), and `mocks.sysspec.dev` for this
repo's own deployment).

Because the URL shapes are Microcks', the smoke suite is the gate:

```sh
sysspec mocks test --serve                              # task mocks:parity
sysspec mocks test --microcks-url https://mocks.sysspec.dev \
                   --async-minion-url https://mocks.sysspec.dev
```

That is the same suite `task mocks:test` runs against Microcks. Agreement
between the two engines is proven on every push and every preview, never
asserted.

What the served mocks deliberately do not do, because Microcks does it and
this engine will not guess at it:

- **Body-aware dispatch and templating.** Cases dispatch by URI only, and
  an example whose payload is templated is a build error rather than a
  payload the two engines would disagree about. Same for two cases on one
  operation that a URI cannot tell apart.
- **Anything not in a contract.** An example naming an operation the
  OpenAPI or AsyncAPI document does not declare is refused: examples
  describe a contract's surface, they never extend it.
- **State.** `POST /orders` returns its example 201; a later `GET` still
  returns the example. That is true of the Microcks mocks too.
- **The Microcks UI and test runner.** Contract tests
  (`task contract:test`) stay with the stack.

## Conventions Microcks imposes

- **AsyncAPI 3.0 imports cleanly into Microcks 1.15** as long as each
  channel carries a single message (the importer's multi-message-operation
  bug, microcks#2273, never bites then).
- **Async mocking needs `ws` channel bindings.** Without a binding the
  async minion has nothing to produce on; every spec channel carries
  `bindings: {ws: {}}`. With bindings plus event examples the minion
  publishes each example every ~3s.
- **Async contract tests need explicit operation `messages` refs.** With
  only a `channel` ref on each operation, the Microcks ASYNC_API_SCHEMA
  runner fails with "messagePathPointer does not represent a valid JSON
  Pointer"; every operation lists
  `messages: [{$ref: '#/channels/<ch>/messages/<Msg>'}]` (the recommended
  AsyncAPI 3 shape).
- **Async contract tests against a real service need a path on the
  endpoint.** The Microcks WS consumer rejects a bare `ws://host:port`
  test endpoint with "found no suitable MessageConsumptionTask
  implementation"; pass `ASYNC_ENDPOINT=ws://<host>:<port>/<any-path>`.
  The REST examples are also replayed verbatim against real
  implementations expecting their exact statuses, so implementations must
  hold the example fixtures.
- **Example artifacts** (`mocks/*.examples.yaml`, Microcks `APIExamples`)
  hold the fixtures so the gated specs don't need example payloads: REST
  operations use a `body:` key and a quoted `status:`; event messages use
  `eventMessage.payload`. The `metadata.name`/`version` must match the
  spec's `info.title`/`info.version` or the upload lands on the wrong
  service; the manifest/spec version lint keeps that honest.
- **Error examples dispatch by URI, not body.** A path-parameterized GET
  can carry a happy and an error case side by side (distinct parameter
  values dispatch to distinct responses). POST error cases (e.g. a 400 for
  an invalid body) would need a body-aware dispatcher on the operation to
  coexist with the happy-path example, so the smoke suite replays error
  surfaces only where URI dispatch reaches them.
