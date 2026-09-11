/** Scaffold a new specs repository.
 *
 * The generated repo owns only its specs: everything substantive sits
 * behind versioned references - the sysspec npm pin (Renovate bumps
 * it), the reusable workflows (@v<major> floating tag) and the Claude Code
 * plugin. Templates live as package data; dotfiles are stored without the
 * leading dot so packaging tools cannot drop them.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYSSPEC_MCP } from "./pins.js";
import { Exit } from "./util.js";

const RENAMES: Record<string, string> = {
  gitignore: ".gitignore",
  "gherkin-lintrc": ".gherkin-lintrc",
  "spectral.yaml": ".spectral.yaml",
  "mcp.json": ".mcp.json",
  github: ".github",
  githooks: ".githooks",
  gitkeep: ".gitkeep",
};

const ORG_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

// Build artifacts and generated data that live inside the docs-site
// template in a development checkout (the repo root symlinks docs-site
// into the templates). Published packages exclude them (npm pack drops
// node_modules everywhere); this skip covers checkout runs.
const SKIP = new Set([
  "docs-site/node_modules",
  "docs-site/.astro",
  "docs-site/src/data/specs.json",
  "docs-site/public/specs",
]);

function templatesRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "init");
}

function ownVersion(): string {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(readFileSync(pkg, "utf-8")).version;
}

function copy(node: string, target: string, subs: Record<string, string>, rel = ""): string[] {
  const written: string[] = [];
  for (const child of readdirSync(node, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${child.name}` : child.name;
    if (SKIP.has(childRel)) continue;
    const out = path.join(target, RENAMES[child.name] ?? child.name);
    const source = path.join(node, child.name);
    if (child.isDirectory()) {
      mkdirSync(out, { recursive: true });
      written.push(...copy(source, out, subs, childRel));
    } else {
      let text = readFileSync(source, "utf-8");
      for (const [key, value] of Object.entries(subs)) {
        text = text.replaceAll(key, value);
      }
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, text);
      // Keep the mode: a git hook that loses its execute bit is silently
      // ignored, and read/write drops it.
      chmodSync(out, statSync(source).mode & 0o777);
      written.push(out);
    }
  }
  return written;
}

export function runInit(targetDir: string, org: string, sysspecRepo: string): number {
  if (!ORG_RE.test(org)) {
    throw new Exit(`--org must be reverse-DNS (e.g. com.acme), got '${org}'`);
  }
  const target = targetDir;
  let existing: string[] = [];
  try {
    existing = readdirSync(target);
  } catch {
    existing = [];
  }
  if (existing.length) {
    throw new Exit(`${target} exists and is not empty`);
  }
  mkdirSync(target, { recursive: true });

  const version = ownVersion();
  const subs: Record<string, string> = {
    __ORG__: org,
    __KIT_VERSION__: version,
    __KIT_MAJOR__: `v${version.split(".")[0]}`,
    __MCP_VERSION__: SYSSPEC_MCP.split("@")[1],
    __SYSSPEC_REPO_SLUG__: sysspecRepo,
  };
  const written = copy(templatesRoot(), target, subs);
  for (const p of written.sort()) {
    console.log(`  ${path.relative(target, p)}`);
  }
  console.log(
    `\nscaffolded ${written.length} file(s) into ${target} ` +
      `(sysspec ${version}, org ${org})\n\n` +
      "Next steps:\n" +
      "  git init && git add -A && git commit -m 'chore: scaffold specs'\n" +
      "  mise install && task setup  # pinned toolchain + the pre-commit hook\n" +
      "  task ci                     # gates + mock cycle, green from the start\n" +
      "  Replace the greeter starter service with your first real one.\n" +
      "  Enable Renovate and GitHub Pages on the repository.",
  );
  return 0;
}
