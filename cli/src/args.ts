/** A tiny hand-rolled flag parser keeps behavior (including the `--` tail
 * split done before parsing) predictable.
 */

import { Exit } from "./util.js";

export class Args {
  private flags = new Map<string, string | true>();
  positional: string[] = [];

  constructor(argv: string[], private usage: string) {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg.startsWith("--")) {
        const eq = arg.indexOf("=");
        if (eq !== -1) {
          this.flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
          this.flags.set(arg.slice(2), argv[++i]);
        } else {
          this.flags.set(arg.slice(2), true);
        }
      } else {
        this.positional.push(arg);
      }
    }
  }

  get(name: string, fallback: string | null = null): string | null {
    const v = this.flags.get(name);
    if (v === undefined) return fallback;
    if (v === true) throw new Exit(`${this.usage}: --${name} needs a value`);
    return v;
  }

  require(name: string): string {
    const v = this.get(name);
    if (v === null) throw new Exit(`${this.usage}: --${name} is required`);
    return v;
  }

  int(name: string, fallback: number): number {
    const v = this.get(name);
    if (v === null) return fallback;
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) throw new Exit(`${this.usage}: --${name} needs an integer, got '${v}'`);
    return n;
  }

  /** A typo'd flag must not silently fall back to a default. */
  only(...names: string[]): void {
    for (const name of this.flags.keys()) {
      if (!names.includes(name)) throw new Exit(`${this.usage}: unknown flag --${name}`);
    }
  }
}
