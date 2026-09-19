---
name: consume-service
description: Build a consumer of a spec suite service, meaning a UI, client app, or downstream system that calls its API or subscribes to its events, against mocks and before or without the real service existing. Use when asked to build a frontend or client against orders or payments, integrate with a service's API or events from outside, generate a client from the contracts, or develop against mock data.
---

# Consume a spec suite service

You are building something that *uses* a service. You implement none of its
contracts; you rely on them. The mock stack stands in for the real service,
so the consumer can be built and verified end-to-end before an
implementation exists. Every path below is parameterized by the consumed
service's name; a consumer may pin more than one.

## Phase 0. Locate the contracts and mocks

- **Interactive sessions** use the `sysspec` MCP tools. `get_service(<name>)`
  gives the surface, `get_acceptance_criteria(<name>)` what the service
  guarantees, `get_message_schema(<name>, <Message>)` the event shapes, and
  `trace_channel(<address>)` who else is on a channel.
- **CI, and anything needing reproducible paths**, pins a released surface
  in `contracts.lock`, exactly as an implementation repo does (see
  `skills/implement-service/SKILL.md` step 2 for how to pick the tag, write
  the lock, and fetch). The fetch is identical, mock stack included:

  ```yaml
  contracts:fetch:
    desc: Fetch the pinned contract surface and mock stack into read-only .contracts/
    cmds:
      - |
        sha=$(awk '/^sha:/{print $2}' contracts.lock)
        chmod -R u+w .contracts 2>/dev/null || true
        rm -rf .contracts && git init -q .contracts
        git -C .contracts remote add origin https://github.com/__SPECS_REPO__
        git -C .contracts sparse-checkout set specs/<service> mocks cli
        git -C .contracts fetch -q --depth 1 origin "$sha"
        git -C .contracts checkout -q FETCH_HEAD
        chmod -R a-w .contracts/specs
  ```

  Root files (`Taskfile.yml`) ride along with a cone-mode sparse checkout,
  so the specs' own mock tasks run from the pin, with no copies:

  ```sh
  task -d .contracts mocks:load SERVICE=<service>   # start stack, load pinned specs + examples
  task -d .contracts mocks:down
  ```

## Ground rules

- The contracts bind the *service*; you inherit them read-only. Never edit
  anything under `.contracts/`. If a contract blocks you, that is a spec
  suite change to propose, not a local fix.
- The feature files are the behavioural contract to **rely on**, not
  scenarios to bind, because the service's implementers own the step
  definitions.
  Read them to learn what a 409 means, when an order becomes `paid`, what
  delivery guarantees hold; test *your* behaviour on top of those promises.
- Generate client types from the fetched specs; never hand-model a payload
  from memory or from observed mock traffic.
- Honour the event conventions the features state: dedupe on the CloudEvents
  envelope `id`, expect at-least-once delivery, assume ordering only within
  an aggregate, and tolerate additive change, because a minor bump must
  never break you.

## Phase 1. Interview

1. **Which service or services are consumed?** Ask if it is not already
   stated.
2. **What kind of consumer is it?** A UI, a service, a batch job, an agent.
3. **Which language and framework?** That also picks the type-generation
   tool.
4. **Which event transport in production?** Mocks emit over WebSocket,
   while the real subscription (Kafka, MQTT, AMQP, SSE and so on) is the
   consumer's choice and only changes the adapter, never the envelope
   handling.
5. **Where does the consumer live?** Its own repository, as with
   implementations.

Do **not** interview about anything the contract decides: endpoints, status
codes, payload shapes, event semantics.

## Phase 2. Build against the mocks

Two ways to run them, same contracts, same fixtures, same URL shapes:

- `task -d .contracts mocks:serve` needs no Docker and starts in a second
  (`http://localhost:8686`, `PORT=` to move it). Prefer it while building.
- `task -d .contracts mocks:load SERVICE=<service>` starts the Microcks
  stack (`http://localhost:8585`, events on `:8081`), which additionally
  runs the contract tests and its own UI.
- A spec suite may publish hosted mocks - this one serves
  <https://mocks.sysspec.dev> - which need nothing local at all. Treat a
  hosted mock as a convenience for exploring and demoing; CI pins and runs
  its own, so the surface under test is the one in `contracts.lock`.

Point the client at whichever is running (title and version come from the
spec's `info` block; the served mocks list every URL at `/`):
  - REST mocks answer at `<mock-url>/rest/<Title>/<version>/...` with
    fixture data included, so list and detail screens render real-looking
    aggregates. Responses carry permissive CORS headers, so a browser
    consumer can call them directly.
  - Events arrive on `<mock-url>/api/ws/<Title>/<version>/<operation>` over
    WebSocket, emitting the example CloudEvents every few seconds. Run
    `task -d .contracts mocks:watch CHANNEL=<Title>/<version>/<operation>`
    to eyeball them (add `--async-minion-url` for a mock that is not the
    local minion).
  - Mock cases dispatch by URI: a detail screen gets the example aggregate
    only for the example's own id. The mocks are stateless, so a POST never
    changes what a later GET returns.
- Generate types from `.contracts/specs/<service>/openapi/*.yaml` and the
  message payload schemas in the AsyncAPI file; wire the client through
  them.
- A UI built this way is demonstrable, with data, before any backend
  exists.

## Phase 3. Verify (the consumer's definition of done)

The suite must run headlessly against the mock stack (this is also the
`contracts:verify` task the sync loop calls):

1. **Client flows against the REST mocks.** Every call the consumer makes
   is exercised against the mocks, with responses parsed through the
   generated types.
2. **Event handling against real envelopes.** Feed the handler from the WS
   mock or directly from `.contracts/mocks/<service>.events.examples.yaml`, and
   validate each consumed payload against the AsyncAPI schema before acting
   on it.
3. **Idempotence.** Replaying the same envelope `id` must not double-apply.
   The features promise at-least-once delivery, so this is contract rather
   than hygiene.
4. **Falsifiability.** Prove the suite *can* fail. A verify suite whose
   checks are empty shells passes forever and verifies nothing. Run it once
   against the CLI's null service, which answers `200 {}` to every request
   and emits no events, and require zero passes (when the runner emits
   cucumber-format JSON:
   `BASE_URL=http://localhost:9099 task -d .contracts null:run
   RESULTS=<file> -- <suite cmd>`); or, minimally, run it with the mock
   stack down and confirm everything fails. Anything that stays green
   against a service answering `200 {}` to everything is not a check.

Green here proves the consumer satisfies the pinned surface's examples and
schemas, and the lock records exactly which surface that was. It does not
prove the real service behaves; that is the *service's* verification loop.

## Phase 4. Wire the consumer's CI

mise-action → `task contracts:fetch` → the mocks → the phase 3 suite. With
`task -d .contracts mocks:serve` the mocks are a background process and
there is no Docker in the job; with `mocks:load` the job ends in
`task -d .contracts mocks:down`. Either way everything resolves against
`.contracts/`, so CI verifies exactly the surface the lock names - never a
hosted URL, which can move under it.

## Phase 5. Stay current

Identical machinery to implementations: the specs publishes
`<service>/v<version>` tags, Renovate bumps `contracts.lock`, and the
templates in `skills/implement-service/templates/` (`renovate.json`,
`contract-converge.yml`) drive the loop. Copy them in and substitute the
service name and specs owner/repo (`__SERVICE__`, `__SPECS_REPO__`), then
define `contracts:verify` as the phase 3 suite. Additive minors go green
and auto-merge, bringing new mocks and new fixtures with no human involved.
A red run or a major bump means the surface moved under you, and only then
does an agent wake to converge the consumer, with the failing suite as its
scope.

## Done when

- [ ] `contracts.lock` pins the intended release tag and its commit sha
- [ ] `task contracts:fetch` produces a read-only `.contracts/` (gitignored)
- [ ] every call and handler runs against the pinned mocks, responses and
      payloads validated through the generated types and schemas
- [ ] replaying an envelope `id` does not double-apply
- [ ] the suite is falsifiable, with zero checks passing against the null
      service (or with the mock stack down)
- [ ] CI runs fetch → the pinned mocks → the phase 3 suite on every push,
      against `.contracts/` rather than a hosted URL
- [ ] `renovate.json` + `contract-converge.yml` installed with the
      placeholders substituted
