#!/usr/bin/env node
/** The `sysspec` command - deterministic gates, lint, docs and mock
 * orchestration for a contract-first service specs. Run from the specs
 * repo's root.
 *
 * The flag parser lives in args.ts; the `--` tail split happens here,
 * before parsing.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Args } from "./args.js";
import * as compat from "./compat.js";
import { checkDiagrams } from "./docs-gen.js";
import { runData } from "./docs-data.js";
import * as intent from "./intent.js";
import * as linters from "./lint.js";
import { runLint as manifestLint } from "./manifest-lint.js";
import * as mocks from "./mocks.js";
import { runNull } from "./nullsvc.js";
import { ownVersion, runInit } from "./scaffold.js";
import * as surface from "./surface.js";
import { defaultBase, envFlag, Exit } from "./util.js";
import * as versioning from "./versioning.js";

const USAGE = `usage: sysspec <command> <subcommand> [flags]

commands:
  check version|compat|intent|surface   diff-based gates against a base ref
  lint manifest|specs|features|datacontracts
  docs data|diagrams
  init <dir> --org <reverse-dns> [--system <title>] [--domain <name>]
  mocks up|down|load|test|watch
  contract test
  null run --results <file> -- <suite command>

sysspec <command> --help shows a command's flags; sysspec --version its version.`;

const HELP: Record<string, string> = {
  check: `usage: sysspec check version|compat|intent|surface [flags]

  version   a changed gated artifact bumps its manifest version and the
            service version, upwards only; an artifact major forces a
            service major
  compat    a breaking contract change carries a major bump
  intent    every schema element added is named in a feature file
  surface   changes under --paths bump the version in --version-file

flags:
  --base <ref>             base to diff against (default $SYSSPEC_BASE, else
                           origin/$GITHUB_BASE_REF, else origin/main)
  --specs-dir <dir>        specs root (default specs)
  --service <name>         compat, intent: one service only
  --version-file <file>    surface: the JSON or TOML file holding the version
  --json-key <key>         surface: dotted key of the version (default version)
  --paths <a/,b/>          surface: comma-separated path prefixes
  --allow-missing-base     skip, even in CI, when the base ref does not exist`,
  lint: `usage: sysspec lint manifest|specs|features|datacontracts [flags]

  manifest       manifests against contracts and the spec graph
  specs          Spectral over the OpenAPI and AsyncAPI contracts
  features       gherkin-lint over the acceptance criteria
  datacontracts  ODCS 3.2 schema, datacontract-cli and Spectral

flags:
  --specs-dir <dir>   specs root (default specs)
  --service <name>    one service only`,
  docs: `usage: sysspec docs data|diagrams [flags]

  data       write the spec data the docs site renders
  diagrams   parse every mermaid diagram in the generated site

flags:
  --specs-dir <dir>   specs root (default specs)
  --site-dir <dir>    docs site (default docs-site)
  --mocks-dir <dir>   data: mock examples (default mocks)
  --docs-dir <dir>    diagrams: extra markdown docs (default docs)`,
  init: `usage: sysspec init <dir> --org <reverse-dns> [flags]

flags:
  --org <reverse-dns>      event namespace, e.g. com.acme (required)
  --system <title>         the system's display name
  --domain <name>          the business domain
  --sysspec-repo <o/r>     where the reusable workflows live
                           (default hungovercoders/sysspec)`,
  mocks: `usage: sysspec mocks up|down|load|test|watch [flags]

  up, down   start or stop the Microcks stack
  load       upload every contract and example to Microcks
  test       smoke-test the loaded mocks
  watch      print the events published on --channel

flags:
  --compose-file <file>      up, down, load: compose file (default: bundled)
  --service <name>           load, test: one service only
  --specs-dir <dir>          load, test: specs root (default specs)
  --mocks-dir <dir>          load, test: examples (default mocks)
  --microcks-url <url>       default http://localhost:8585
  --async-minion-url <url>   default http://localhost:8081
  --channel <address>        watch: the channel address (required)`,
  contract: `usage: sysspec contract test [flags]

flags:
  --service <name>          one service only
  --specs-dir <dir>         specs root (default specs)
  --microcks-url <url>      default http://localhost:8585
  --rest-endpoint <url>     the implementation's REST base URL
  --async-endpoint <url>    the implementation's broker endpoint`,
  null: `usage: sysspec null run --results <file> [flags] -- <suite command>

  Runs the suite against a service that answers 200 {} to everything:
  every scenario must fail, or its step bindings prove nothing.

flags:
  --results <file>   cucumber JSON the suite writes (required)
  --port <n>         null service port (default 9099)
  --timeout <s>      suite timeout in seconds (default 300)`,
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let tail: string[] = [];
  const split = argv.indexOf("--");
  if (split !== -1) {
    tail = argv.slice(split + 1);
    argv = argv.slice(0, split);
  }

  if (argv[0] === "--version") {
    console.log(ownVersion());
    return 0;
  }
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP[argv.find((a) => !a.startsWith("-")) ?? ""] ?? USAGE);
    return 0;
  }

  // Flags may sit anywhere, before or after the subcommand: parse the
  // whole line, then read the command words from what is left.
  const args = new Args(argv, "sysspec");
  const [command, sub, ...extra] = args.positional;
  const usage = `sysspec ${command ?? ""} ${sub ?? ""}`.trim();
  args.usage = usage;
  // Stray words must not be silently ignored: `lint specs orders` would
  // lint every service while looking like it linted one.
  if (extra.length) {
    throw new Exit(
      `${usage}: unexpected argument '${extra[0]}'` +
        (command === "lint" || command === "check" ? " - did you mean --service?" : ""),
    );
  }

  if (command === "check") {
    // --base, else SYSSPEC_BASE / the PR's base branch / origin/main.
    const base = args.get("base", defaultBase())!;
    const specsDir = args.get("specs-dir", "specs")!;
    // The flag, or SYSSPEC_ALLOW_MISSING_BASE for callers that cannot
    // change the command line (the reusable workflow's scaffolded Taskfile).
    const allowMissing = args.bool("allow-missing-base") || envFlag("SYSSPEC_ALLOW_MISSING_BASE");
    if (sub === "version") {
      args.only("base", "specs-dir", "allow-missing-base");
      return versioning.runGate(base, specsDir, allowMissing);
    }
    if (sub === "compat") {
      args.only("base", "specs-dir", "service", "allow-missing-base");
      return compat.runGate(base, args.get("service"), specsDir, allowMissing);
    }
    if (sub === "intent") {
      args.only("base", "specs-dir", "service", "allow-missing-base");
      return intent.runGate(base, args.get("service"), specsDir, allowMissing);
    }
    if (sub === "surface") {
      args.only("base", "specs-dir", "version-file", "json-key", "paths", "allow-missing-base");
      return surface.runGate(
        base,
        args.require("version-file"),
        args.get("json-key", "version")!,
        args.require("paths").split(",").filter(Boolean),
        allowMissing,
      );
    }
  }
  if (command === "lint") {
    args.only("specs-dir", "service");
    const specsDir = args.get("specs-dir", "specs")!;
    const service = args.get("service");
    if (sub === "manifest") return manifestLint(service, specsDir);
    if (sub === "specs") return linters.specs(service, specsDir);
    if (sub === "features") return linters.features(service, specsDir);
    if (sub === "datacontracts") return linters.datacontracts(service, specsDir);
  }
  if (command === "init") {
    // argparse form: sysspec init <dir> --org com.acme [--system "Acme Commerce"]
    //                [--domain Commerce] [--sysspec-repo o/r]
    args.only("org", "system", "domain", "sysspec-repo");
    const dir = sub;
    if (!dir) throw new Exit("sysspec init: a target directory is required");
    return runInit(
      dir,
      args.require("org"),
      args.get("sysspec-repo", "hungovercoders/sysspec")!,
      args.get("system"),
      args.get("domain"),
    );
  }
  if (command === "docs") {
    const specsDir = args.get("specs-dir", "specs")!;
    if (sub === "data") {
      args.only("specs-dir", "site-dir", "mocks-dir");
      return runData(specsDir, args.get("site-dir", "docs-site")!, args.get("mocks-dir", "mocks")!);
    }
    if (sub === "diagrams") {
      args.only("specs-dir", "docs-dir", "site-dir");
      return checkDiagrams(specsDir, args.get("docs-dir", "docs")!, args.get("site-dir", "docs-site")!);
    }
  }
  if (command === "mocks") {
    if (sub === "watch") {
      args.only("channel", "async-minion-url");
      return mocks.watch(
        args.require("channel"),
        args.get("async-minion-url", "http://localhost:8081")!,
      );
    }
    if (sub === "up" || sub === "down") {
      args.only("compose-file");
      // Resolved only here: the bundled fallback materializes .sysspec/,
      // which a typo'd subcommand must not leave behind.
      const compose = mocks.composeFile(args.get("compose-file"));
      return sub === "up" ? mocks.up(compose) : mocks.down(compose);
    }
    if (sub === "load" || sub === "test") {
      const service = args.get("service");
      const specsDir = args.get("specs-dir", "specs")!;
      const mocksDir = args.get("mocks-dir", "mocks")!;
      const microcksUrl = args.get("microcks-url", "http://localhost:8585")!;
      const minionUrl = args.get("async-minion-url", "http://localhost:8081")!;
      if (sub === "load") {
        args.only("compose-file", "service", "specs-dir", "mocks-dir", "microcks-url", "async-minion-url");
        const compose = mocks.composeFile(args.get("compose-file"));
        return mocks.load(service, specsDir, mocksDir, microcksUrl, minionUrl, compose);
      }
      args.only("service", "specs-dir", "mocks-dir", "microcks-url", "async-minion-url");
      return mocks.test(service, specsDir, mocksDir, microcksUrl, minionUrl);
    }
  }
  if (command === "contract" && sub === "test") {
    args.only("service", "specs-dir", "microcks-url", "rest-endpoint", "async-endpoint");
    return mocks.contract(
      args.get("service"),
      args.get("specs-dir", "specs")!,
      args.get("microcks-url", "http://localhost:8585")!,
      args.get("rest-endpoint"),
      args.get("async-endpoint"),
    );
  }
  if (command === "null" && sub === "run") {
    args.only("port", "results", "timeout");
    return runNull(
      args.int("port", 9099),
      args.require("results"),
      args.int("timeout", 300),
      tail,
    );
  }

  console.error(HELP[command] ?? USAGE);
  return 2;
}

/** True when this module is the process entry (the npm bin, which npx
 * reaches through a symlink, or `node dist/cli.mjs`), false when imported
 * - so tests can drive main() without it also running on import. */
function isEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Exit ? err.message : err);
      process.exitCode = 1;
    });
}
