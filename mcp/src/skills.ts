/** The sysspec process skills, served over MCP so any client — not one
 * particular product — can pull the deeper working processes the same way
 * it pulls specs.
 *
 * The content is baked in at build time (scripts/bundle-skills.mjs →
 * src/generated/skills-bundle.json, inlined by tsup): one source under
 * skills/ in the repo, no filesystem read at serve time, so the npm
 * package, the committed dist, the Docker image and the worker adapter
 * all carry identical skills. There is deliberately no fs fallback — an
 * installed package has no skills directory to fall back to.
 */

import { bounded } from "./bounded.js";
import { DEFAULT_MAX_BYTES } from "./core.js";
import { pyList, pyRepr, pySorted } from "./pyformat.js";
import bundleJson from "./generated/skills-bundle.json" with { type: "json" };

interface Skill {
  name: string;
  description: string;
  body: string;
  files: Record<string, string>;
}

const SKILLS: Skill[] = (bundleJson as unknown as { skills: Skill[] }).skills;

function utf8Len(text: string): number {
  return new TextEncoder().encode(text).length;
}

function skill(name: string): Skill {
  const found = SKILLS.find((s) => s.name === name);
  if (!found) {
    throw new Error(
      `No skill ${pyRepr(name)}. Available: ${pyList(pySorted(SKILLS.map((s) => s.name)))}`,
    );
  }
  return found;
}

export function listSkills(): object[] {
  return SKILLS.map((s) => ({
    name: s.name,
    description: s.description,
    files: pySorted(Object.keys(s.files)),
    total_bytes: utf8Len(s.body),
  }));
}

export interface GetSkillArgs {
  name: string;
  file?: string | null;
  max_bytes?: number;
}

export function getSkill(args: GetSkillArgs): object {
  const { name, file = null, max_bytes = DEFAULT_MAX_BYTES } = args;
  const s = skill(name);
  let text: string;
  if (file !== null && file !== undefined) {
    const body = s.files[file];
    if (body === undefined) {
      throw new Error(
        `No file ${pyRepr(file)} on skill ${pyRepr(name)}. ` +
          `Files: ${pyList(pySorted(Object.keys(s.files)))}`,
      );
    }
    text = body;
  } else {
    text = s.body;
  }
  const { text: content, truncated, totalBytes } = bounded(text, max_bytes);
  const out: Record<string, unknown> = {
    name: s.name,
    description: s.description,
    file: file ?? null,
    files: pySorted(Object.keys(s.files)),
    content,
    truncated,
    total_bytes: totalBytes,
  };
  if (truncated) {
    out.note = `Truncated at ${max_bytes} of ${totalBytes} bytes. Raise max_bytes to read the rest.`;
  }
  return out;
}
