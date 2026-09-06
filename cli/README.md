# sysspec (CLI)

The `sysspec` command on npm: deterministic gates, lint, generated docs,
Microcks mock orchestration and the `init` scaffold for a contract-first
spec repository.

```bash
npx -y sysspec init my-specs --org com.acme   # scaffold a spec repo
npx -y sysspec lint manifest                  # any command, ad hoc
```

Scaffolded repos pin `sysspec@<version>` in their Taskfile (Renovate bumps
it, npm datasource); this repo's own Taskfile runs the committed bundle
`dist/cli.mjs` directly, so a checkout needs nothing but node.

External tools the CLI shells out to are pinned in `src/pins.ts`:
spectral, gherkin-lint, @asyncapi/cli and mermaid-cli via `npx`,
`oasdiff` from the mise toolchain, docker compose for the Microcks
stack — and `datacontract-cli` via `uvx`, the one Python tool left
(no npm equivalent for ODCS validation), which is why `uv` stays in
`mise.toml`.

## Layout

- `src/` — the command implementations; `cli.ts` is the entry.
- `templates/` — everything `sysspec init` lays down (dotfiles stored
  undotted so packaging tools cannot drop them; `scaffold.ts` renames on
  copy), plus the bundled Spectral ruleset and Microcks compose file.
- `dist/cli.mjs` — committed dependency-free bundle. `task check:cli:dist`
  fails when it is stale: rebuild (`npm run build`) and commit with any
  `src/` or `templates/`-adjacent change.
- `test/` — vitest suite: golden `specs.json` byte-comparison against a
  frozen snapshot (`test/fixtures/expected-specs.json`), gate logic units, scaffold/rename/packaging pins (`pack.test.ts` guards the
  npm tarball contents), and the null-service falsifiability gate.

## Development

```bash
cd cli
npm install
npm test
npm run build   # refresh dist/ — commit it
```

Releases: tag `v<version>` matching `package.json` — `release.yml`
publishes to npm via trusted publishing and moves the floating `v<major>`
tag adopter workflows reference. See CONTRIBUTING.md.
