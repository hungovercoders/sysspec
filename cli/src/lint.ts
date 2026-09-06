/** Static linters over the specs's specs, features and data contracts. */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATACONTRACT_CLI, GHERKIN_LINT, SPECTRAL_CLI } from "./pins.js";
import { run } from "./util.js";
import { serviceDirs as allServiceDirs } from "./manifest-lint.js";

// datacontract-cli validates a contract against the ODCS schema and offers no
// hook for house rules, so the naming half of the data-contract gate is
// Spectral - it lints any YAML, not just OpenAPI/AsyncAPI. A repo overrides
// the bundled default by dropping its own file at the root. datacontract-cli
// is the toolchain's one Python tool, fetched by uvx.
const DC_RULESET_NAME = ".spectral-datacontracts.yaml";
const DC_RULESET_DEFAULT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "spectral",
  "datacontracts.yaml",
);

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function serviceDirs(specsDir: string, only: string | null): string[] {
  const dirs = allServiceDirs(specsDir).filter((d) => !only || path.basename(d) === only);
  if (dirs.length === 0) {
    console.error(`no services matching '${only || "*"}' under ${specsDir}/`);
    process.exit(1);
  }
  return dirs;
}

function globYaml(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function spectral(files: string[], ruleset: string | null = null): number {
  const args = ["npx", "-y", SPECTRAL_CLI, "lint", ...files, "--fail-severity=warn"];
  if (ruleset !== null) args.push("--ruleset", ruleset);
  return run(args, { inherit: true }).status;
}

export function specs(only: string | null, specsDir: string): number {
  const files: string[] = [];
  for (const d of serviceDirs(specsDir, only)) {
    for (const kind of ["asyncapi", "openapi"]) {
      files.push(...globYaml(path.join(d, kind)));
    }
  }
  if (files.length === 0) {
    console.error(`no specs found for '${only || "*"}'`);
    return 1;
  }
  return spectral(files);
}

export function features(only: string | null, specsDir: string): number {
  const dirs = serviceDirs(specsDir, only)
    .map((d) => path.join(d, "features"))
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
  if (dirs.length === 0) {
    console.log(`no feature directories for '${only || "*"}'`);
    return 0;
  }
  return run(["npx", "-y", GHERKIN_LINT, ...dirs], { inherit: true }).status;
}

export function datacontracts(only: string | null, specsDir: string): number {
  const files: string[] = [];
  for (const d of serviceDirs(specsDir, only)) {
    files.push(...globYaml(path.join(d, "data-contracts")));
  }
  if (files.length === 0) {
    console.log(`no data contracts for '${only || "*"}'`);
    return 0;
  }

  for (const dc of files) {
    console.log(`linting ${dc}`);
    const rc = run(["uvx", "--from", DATACONTRACT_CLI, "datacontract", "lint", dc], {
      inherit: true,
    }).status;
    if (rc) return rc;
  }

  const ruleset = isFile(DC_RULESET_NAME) ? DC_RULESET_NAME : DC_RULESET_DEFAULT;
  console.log(`checking data contract naming against ${ruleset}`);
  return spectral(files, ruleset);
}
