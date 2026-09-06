import { defineConfig } from "tsup";

// One config, two artifacts: dist/stdio.mjs (the bin, also committed so the
// Claude plugin can run it straight from a checkout with nothing but node)
// and dist/index.mjs (the library export). Everything is inlined —
// dependency-free single files — and left unminified so committed diffs
// stay reviewable.
export default defineConfig({
  entry: { stdio: "src/stdio.ts", index: "src/index.ts" },
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
