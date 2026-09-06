# Working in this repository (agents)

This repository is the spec of record for its services. README.md has the
layout; the points below are the agent-specific sharp edges.

- **The specs are the authority.** Gated artifacts (AsyncAPI, OpenAPI,
  data contracts, feature files) are never edited to make a check, test,
  or implementation pass. They document system intent; if a gated
  artifact looks wrong, stop and say so — changing it is a deliberate,
  versioned act with its own gates.
- **Verify through `task`, nothing else.** `task ci` is the definition of
  green — the same gates run locally, in the pre-commit hook and in CI.
  Do not re-implement checks ad hoc or bypass a failing gate; a red gate
  is information, and the negative result gets reported as-is.
- **Read the specs through the MCP tools** (the `sysspec` server wired up
  in `.mcp.json`): `list_services`, `get_service`, `get_artifact`,
  `get_message_schema`, `get_acceptance_criteria`, `trace_channel`,
  `search_specs` — the tools say which artifacts are gated and who
  consumes what. The deeper processes are served the same way: call
  `list_skills`, then `get_skill` — authoring conventions (`sysspec`),
  implementing a service for real (`implement-service`), or building a
  consumer against its mocks (`consume-service`).
- **Version everything you touch.** A gated artifact change bumps both
  the artifact version and the service's top-level version in
  `service.yaml`; merges to main publish each changed service as a
  `<service>/v<version>` git tag that implementation and consumer repos
  pin. `task check` enforces this.
