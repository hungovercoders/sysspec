# Mocks

Microcks serves every specified service from one stack: REST mocks from the
OpenAPI contracts, ambient WebSocket events from the AsyncAPI contracts.

```sh
task mocks:load             # start the stack and load all services
task mocks:test             # smoke-test the mocks
task mocks:load SERVICE=orders
```

REST mocks: `http://localhost:8585/rest/<info.title>/<version>/...` (spaces
in the title become `+`). Event channels:
`ws://localhost:8081/api/ws/<info.title>/<version>/<operationName>`.

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
  service — the manifest/spec version lint keeps that honest.
- **Error examples dispatch by URI, not body.** A path-parameterized GET
  can carry a happy and an error case side by side (distinct parameter
  values dispatch to distinct responses). POST error cases (e.g. a 400 for
  an invalid body) would need a body-aware dispatcher on the operation to
  coexist with the happy-path example, so the smoke suite replays error
  surfaces only where URI dispatch reaches them.
