import { defineConfig } from "tsup";

// One committed, dependency-free bundle (dist/cli.mjs): the npm bin, and
// what the repo's own Taskfile and the Claude plugin run straight from a
// checkout with nothing but node. Unminified so committed diffs stay
// reviewable. Mirrors mcp/tsup.config.ts.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  banner: {
    // Some inlined CJS dependencies call require() at runtime; give the
    // ESM bundle a real one.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = /* @__PURE__ */ __createRequire(import.meta.url);",
  },
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  target: "node20",
  noExternal: [/.*/],
  minify: false,
  sourcemap: false,
  clean: true,
  dts: false,
  splitting: false,
});
