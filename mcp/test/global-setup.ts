/** Generate the baked skills bundle before any test module loads —
 * src/skills.ts imports the JSON statically, so a beforeAll would be too
 * late, and the Taskfile runs vitest directly (npm pretest never fires).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  execFileSync(process.execPath, [path.join(here, "..", "scripts", "bundle-skills.mjs")]);
}
