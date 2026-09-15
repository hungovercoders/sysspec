/** Static linters over the specs's specs, features and data contracts. */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2019.js";
import { parse } from "yaml";
import { serviceDirs } from "./mocks.js";
import { DATACONTRACT_CLI, GHERKIN_LINT, SPECTRAL_CLI } from "./pins.js";
import { run } from "./util.js";

// The data-contract gate is three checks over the same files, because no
// one tool does the job:
//
// 1. the ODCS JSON Schema, applied strictly (below) - datacontract-cli's
//    own lint is deliberately permissive and passes documents the standard
//    rejects, so this is what actually holds a contract to the version it
//    declares;
// 2. datacontract-cli, which catches what the schema cannot express and is
//    the toolchain's one Python tool, fetched by uvx;
// 3. Spectral for house naming rules, which neither of the others hooks. A
//    repo overrides the bundled ruleset by dropping its own file at the
//    root.
const DC_RULESET_NAME = ".spectral-datacontracts.yaml";
const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const DC_RULESET_DEFAULT = path.join(TEMPLATES, "spectral", "datacontracts.yaml");
// Vendored, not fetched: the gate has to mean the same thing offline, in CI
// and in a year. Bumping ODCS is a deliberate act - swap this file, and the
// contracts that fail against it are the migration work.
const ODCS_SCHEMA = path.join(TEMPLATES, "odcs", "odcs-json-schema-v3.2.0.json");

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
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

/** Validate one parsed ODCS document against the vendored JSON Schema.
 *
 * Returns the problems, deduplicated and shortened: ajv reports every
 * branch of a `oneOf`, which for this schema means a dozen lines saying
 * the same thing about the same pointer.
 */
export function odcsSchemaProblems(doc: unknown, validate: (d: unknown) => boolean): string[] {
  if (validate(doc)) return [];
  const errors = (validate as unknown as { errors?: Record<string, any>[] }).errors ?? [];
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const e of errors) {
    const where = e.instancePath || "/";
    const line = `${where}: ${e.message}`;
    if (seen.has(line)) continue;
    seen.add(line);
    problems.push(line);
  }
  return problems;
}

export function validateOdcs(files: string[]): number {
  const schema = JSON.parse(readFileSync(ODCS_SCHEMA, "utf-8"));
  // strict:false - the published schema uses keywords and formats ajv does
  // not know; unknown formats are not what this gate is for.
  const ajv = new (Ajv as unknown as { default: any }).default({
    strict: false,
    allErrors: true,
    logger: false,
  });
  const validate = ajv.compile(schema);
  let failed = 0;
  for (const dc of files) {
    const problems = odcsSchemaProblems(parse(readFileSync(dc, "utf-8")), validate);
    if (problems.length === 0) continue;
    failed = 1;
    console.error(`${dc}: does not satisfy ${path.basename(ODCS_SCHEMA)}`);
    for (const p of problems) console.error(`  ${p}`);
  }
  return failed;
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

  console.log(`validating against ${path.basename(ODCS_SCHEMA)}`);
  const schemaRc = validateOdcs(files);
  if (schemaRc) return schemaRc;

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
