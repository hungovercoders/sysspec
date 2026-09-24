#!/usr/bin/env node
// Bake a spec tree into src/generated/specs-bundle.json for spec sources
// that have no filesystem (the Cloudflare Worker adapter, or any other
// bundled deployment). Only declared artifacts are included, preserving
// the server's "an undeclared file is not reachable" property at build
// time. Raw YAML text is stored, not parsed docs, so bundled and
// filesystem sources share one parse path at runtime.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const specsDir = path.resolve(process.env.SPECS_DIR ?? path.join(here, "..", "..", "specs"));
const outFile = path.join(here, "..", "src", "generated", "specs-bundle.json");

const services = [];
const dirs = (await fs.readdir(specsDir, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
for (const dir of dirs) {
  const manifestPath = path.join(specsDir, dir, "service.yaml");
  let manifestYaml;
  try {
    manifestYaml = await fs.readFile(manifestPath, "utf-8");
  } catch {
    continue;
  }
  const manifest = parse(manifestYaml) ?? {};
  const files = {};
  for (const artifact of manifest.artifacts ?? []) {
    const candidate = path.resolve(specsDir, dir, artifact.path);
    if (!candidate.startsWith(path.join(specsDir, dir) + path.sep)) continue;
    try {
      files[artifact.path] = await fs.readFile(candidate, "utf-8");
    } catch {
      // Declared but missing: the server reports that per-read at runtime.
    }
  }
  services.push({ dir, manifestYaml, files });
}

let systemYaml = null;
try {
  systemYaml = await fs.readFile(path.join(specsDir, "system.yaml"), "utf-8");
} catch {
  // No suite manifest: get_system reports that rather than failing.
}

// Write-then-rename: a rename within one directory is atomic, so a reader
// running alongside (parallel test files, a build) sees the old bundle or
// the new one, never a half-written file.
await fs.mkdir(path.dirname(outFile), { recursive: true });
const tmpFile = `${outFile}.${process.pid}.tmp`;
await fs.writeFile(tmpFile, JSON.stringify({ services, systemYaml }));
await fs.rename(tmpFile, outFile);
console.error(`bundled ${services.length} service(s) from ${specsDir} -> ${outFile}`);
