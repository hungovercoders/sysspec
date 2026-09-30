# __SYSTEM_TITLE__ system specs

The spec of record for __SYSTEM_TITLE__ (__SYSTEM_DOMAIN__): AsyncAPI,
OpenAPI, ODCS data contracts and Gherkin acceptance criteria, holding
system intent as versioned, gated artifacts. Built on
[sysspec](https://sysspec.dev).

- `task ci` is the definition of green - the same gates run locally and in
  CI. The git hooks run tiers of them: lint and the diff gates before each
  commit (`task check:fast`), plus the docs build before each push.
  `task setup` installs the pinned toolchain (mise) and the hooks; the mock
  cycle (`contract:test`, `mocks:test`) additionally needs a running
  Docker daemon.
- Gated artifacts are never edited to make an implementation pass. Bump the
  artifact and service versions in `service.yaml` with every change; merges
  to main publish each changed service as a `<service>/v<version>` git tag
  that implementation and consumer repos pin.
- `task mocks:load` stands up Microcks mocks of every service so UIs and
  consumers can build before implementations exist.
- The machinery arrives by reference and stays current via Renovate: the
  `sysspec@` pin in `Taskfile.yml`, the `sysspec-mcp@` pin in
  `.mcp.json` (both npm), and the reusable workflows under `.github/workflows/`.
- Anyone can ask these specs questions over MCP. The catalog's **Ask
  these specs** page has the connect line and starter questions drawn from
  this suite. It is the same server agents build from, so a product
  question and an implementation get the same answer.
- Agents get the same specs over MCP (`.mcp.json`) and the deeper
  processes via the sysspec plugin's skills. Install with
  `/plugin marketplace add __SYSSPEC_REPO_SLUG__` then `/plugin install`,
  and ask to implement or consume a service. The `implement-service` and
  `consume-service` skills carry the whole loop, from contract pin to
  verified definition of done, and read as walkthroughs in their own
  right.

- `specs/system.yaml` describes the system as a whole, naming its title,
  its domain, its event namespace and, once you host one, the `mcp:`
  endpoint these specs answer questions on. It annotates every page of the generated catalog, so
  fill it in for real once the starter service is gone.

The `greeter` service is scaffold output - replace it with your first real
service.
