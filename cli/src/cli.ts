#!/usr/bin/env node
/** The `sysspec` command - deterministic gates, lint, docs and mock
 * orchestration for a contract-first service specs. Run from the specs
 * repo's root.
 *
 * A tiny hand-rolled parser keeps behavior (including the `--` tail
 * split done before parsing) predictable.
 */

import * as compat from "./compat.js";
import { checkDiagrams } from "./docs-gen.js";
import { runData } from "./docs-data.js";
import * as intent from "./intent.js";
import * as linters from "./lint.js";
import { runLint as manifestLint } from "./manifest-lint.js";
import * as mocks from "./mocks.js";
import { runNull } from "./nullsvc.js";
import { runInit } from "./scaffold.js";
import * as surface from "./surface.js";
import { Exit } from "./util.js";
import * as versioning from "./versioning.js";

class Args {
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
    return v === null ? fallback : parseInt(v, 10);
  }
}

const USAGE = `usage: sysspec <command> ...

commands:
  check version|compat|intent|surface   diff-based gates against a base ref
  lint manifest|specs|features|datacontracts
  docs data|diagrams
  init <dir> --org <reverse-dns>
  mocks up|down|load|test|watch
  contract test
  null run --results <file> -- <suite command>`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let tail: string[] = [];
  const split = argv.indexOf("--");
  if (split !== -1) {
    tail = argv.slice(split + 1);
    argv = argv.slice(0, split);
  }

  const [command, sub, ...rest] = argv;
  const args = new Args(rest, `sysspec ${command ?? ""} ${sub ?? ""}`.trim());

  if (command === "check") {
    const base = args.get("base", "origin/main")!;
    const specsDir = args.get("specs-dir", "specs")!;
    if (sub === "version") return versioning.runGate(base, specsDir);
    if (sub === "compat") return compat.runGate(base, args.get("service"), specsDir);
    if (sub === "intent") return intent.runGate(base, args.get("service"), specsDir);
    if (sub === "surface") {
      return surface.runGate(
        base,
        args.require("version-file"),
        args.get("json-key", "version")!,
        args.require("paths").split(",").filter(Boolean),
      );
    }
  }
  if (command === "lint") {
    const specsDir = args.get("specs-dir", "specs")!;
    const service = args.get("service");
    if (sub === "manifest") return manifestLint(service, specsDir);
    if (sub === "specs") return linters.specs(service, specsDir);
    if (sub === "features") return linters.features(service, specsDir);
    if (sub === "datacontracts") return linters.datacontracts(service, specsDir);
  }
  if (command === "init") {
    // argparse form: sysspec init <dir> --org com.acme [--sysspec-repo o/r]
    const dir = sub;
    if (!dir) throw new Exit("sysspec init: a target directory is required");
    return runInit(
      dir,
      args.require("org"),
      args.get("sysspec-repo", "hungovercoders/sysspec")!,
    );
  }
  if (command === "docs") {
    const specsDir = args.get("specs-dir", "specs")!;
    if (sub === "data") {
      return runData(specsDir, args.get("site-dir", "docs-site")!, args.get("mocks-dir", "mocks")!);
    }
    if (sub === "diagrams") {
      return checkDiagrams(specsDir, args.get("docs-dir", "docs")!, args.get("site-dir", "docs-site")!);
    }
  }
  if (command === "mocks") {
    if (sub === "watch") {
      return mocks.watch(
        args.require("channel"),
        args.get("async-minion-url", "http://localhost:8081")!,
      );
    }
    const compose = mocks.composeFile(args.get("compose-file"));
    if (sub === "up") return mocks.up(compose);
    if (sub === "down") return mocks.down(compose);
    const service = args.get("service");
    const specsDir = args.get("specs-dir", "specs")!;
    const mocksDir = args.get("mocks-dir", "mocks")!;
    const microcksUrl = args.get("microcks-url", "http://localhost:8585")!;
    const minionUrl = args.get("async-minion-url", "http://localhost:8081")!;
    if (sub === "load") {
      return mocks.load(service, specsDir, mocksDir, microcksUrl, minionUrl, compose);
    }
    if (sub === "test") {
      return mocks.test(service, specsDir, mocksDir, microcksUrl, minionUrl);
    }
  }
  if (command === "contract" && sub === "test") {
    return mocks.contract(
      args.get("service"),
      args.get("specs-dir", "specs")!,
      args.get("microcks-url", "http://localhost:8585")!,
      args.get("rest-endpoint"),
      args.get("async-endpoint"),
    );
  }
  if (command === "null" && sub === "run") {
    return runNull(
      args.int("port", 9099),
      args.require("results"),
      args.int("timeout", 300),
      tail,
    );
  }

  console.error(USAGE);
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Exit ? err.message : err);
    process.exitCode = 1;
  });
