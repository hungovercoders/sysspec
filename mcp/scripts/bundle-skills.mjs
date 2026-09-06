#!/usr/bin/env node
// Bake the repo's process skills into src/generated/skills-bundle.json so
// tsup inlines them into the served bundle: one source in skills/, served
// identically by the npm package, the committed dist, the Docker image and
// the worker adapter. Each skill is its SKILL.md (frontmatter name and
// description feed list_skills; the markdown body is what get_skill
// serves) plus any companion files beside it (workflow and config
// templates the skill instructs copying).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(process.env.SKILLS_DIR ?? path.join(here, "..", "..", "skills"));
const outFile = path.join(here, "..", "src", "generated", "skills-bundle.json");

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

async function filesUnder(dir, base = dir) {
  const out = {};
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, await filesUnder(p, base));
    } else if (path.relative(base, p) !== "SKILL.md") {
      out[path.relative(base, p).split(path.sep).join("/")] = await fs.readFile(p, "utf-8");
    }
  }
  return out;
}

const skills = [];
const dirs = (await fs.readdir(skillsDir, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
for (const dir of dirs) {
  const skillFile = path.join(skillsDir, dir, "SKILL.md");
  let text;
  try {
    text = await fs.readFile(skillFile, "utf-8");
  } catch {
    continue;
  }
  const match = text.match(FRONTMATTER);
  if (!match) {
    console.error(`bundle-skills: ${skillFile} has no YAML frontmatter`);
    process.exit(1);
  }
  const meta = parse(match[1]) ?? {};
  if (typeof meta.name !== "string" || typeof meta.description !== "string") {
    console.error(`bundle-skills: ${skillFile} frontmatter needs string name and description`);
    process.exit(1);
  }
  if (meta.name !== dir) {
    console.error(`bundle-skills: ${skillFile} frontmatter name '${meta.name}' != directory '${dir}'`);
    process.exit(1);
  }
  const body = text.slice(match[0].length).replace(/^\n+/, "");
  skills.push({
    name: meta.name,
    description: meta.description,
    body,
    files: await filesUnder(path.join(skillsDir, dir)),
  });
}

if (skills.length === 0) {
  console.error(`bundle-skills: no skills found under ${skillsDir}`);
  process.exit(1);
}
await fs.mkdir(path.dirname(outFile), { recursive: true });
await fs.writeFile(outFile, JSON.stringify({ skills }));
console.error(`bundled ${skills.length} skill(s) from ${skillsDir} -> ${outFile}`);
