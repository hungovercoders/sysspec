#!/usr/bin/env node
// Third-party notices for a shipped artifact.
//
// Every artifact this repo publishes redistributes other people's code:
// the npm bundles inline their dependencies (tsup, noExternal), and the
// Astro sites ship bundled client JS, CSS and font files with every
// license comment stripped. MIT, ISC, BSD and OFL all require the
// copyright and permission notices to travel with copies, and Apache-2.0
// additionally requires NOTICE files to be reproduced. This script
// writes one text file that satisfies that for exactly the packages an
// artifact contains.
//
// Two ways to discover what an artifact contains:
//   --bundle <file>     an esbuild/tsup bundle: packages are read from the
//                       `// node_modules/<pkg>/...` markers esbuild leaves.
//   --packages <json>   a JSON array of module ids, as written by the Vite
//                       plugin exported below from an Astro client build.
//   --add <pkg>         extra packages the graph cannot see (fonts pulled
//                       in through CSS, pagefind's runtime, ...).
//
// Usage (no dependencies, node >= 20):
//   node third-party-notices.mjs --title "<artifact>" --out <file>
//        [--root <dir>] (--bundle <file> | --packages <json> | --add <pkg>)...
//   --out-dir <dir> [--out-dir-env <VAR>]  write <dir>/third-party-notices.txt,
//        <VAR> (when set) overriding <dir>; the Astro sites use this.
//
// Canonical copy: scripts/third-party-notices.mjs. The scaffold template
// (cli/templates/init/docs-site/scripts/) carries an identical copy so
// generated catalogs are compliant out of the box; `task check:notices`
// keeps the two in sync.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT_NAME = 'third-party-notices.txt';
const PKG_DIR = /(?:^|[\\/])node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^@\\/][^\\/]*)/g;

/** Package directories (absolute) of every module id that lives in node_modules. */
export function packageDirsFromIds(ids, root = process.cwd()) {
  const dirs = new Set();
  for (const raw of ids) {
    if (typeof raw !== 'string' || raw.startsWith('\0')) continue;
    const id = raw.split('?')[0];
    let last = null;
    for (const m of id.matchAll(PKG_DIR)) last = m;
    if (!last) continue;
    const dir = id.slice(0, last.index + last[0].length);
    dirs.add(path.isAbsolute(dir) ? dir : path.resolve(root, dir));
  }
  return dirs;
}

/** Package directories referenced by esbuild's `// node_modules/...` markers. */
export function packageDirsFromBundle(file, root = process.cwd()) {
  const text = readFileSync(file, 'utf8');
  const ids = [...text.matchAll(/^\/\/ ((?:[^\n]*?[\\/])?node_modules[\\/][^\n]+)$/gm)].map((m) => m[1]);
  return packageDirsFromIds(ids, root);
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function licenseId(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean).join(' OR ');
  if (l && typeof l === 'object') return l.type ?? 'UNKNOWN';
  return 'UNKNOWN';
}

/** A license id read off the license file, for packages whose package.json omits one. */
function inferLicenseId(texts) {
  const t = texts.join('\n');
  if (/Permission is hereby granted, free of charge/.test(t)) return 'MIT';
  if (/Permission to use, copy, modify, and\/or distribute this software/.test(t)) return 'ISC';
  if (/Apache License,? Version 2\.0/.test(t)) return 'Apache-2.0';
  if (/Redistributions in binary form/.test(t)) return /endorse or promote/.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  return 'UNKNOWN';
}

// Canonical permission notices, for packages published under one of these
// licenses without shipping the file: the notice is what the license asks
// to be reproduced, and the copyright holder comes from the manifest.
const CANONICAL = {
  MIT: (holder) => `MIT License\n\nCopyright (c) ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  ISC: (holder) => `ISC License\n\nCopyright (c) ${holder}\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
  'BSD-2-Clause': (holder) => `BSD 2-Clause License\n\nCopyright (c) ${holder}\n\nRedistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n\n1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\n\n2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  'BSD-3-Clause': (holder) => `BSD 3-Clause License\n\nCopyright (c) ${holder}\n\nRedistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n\n1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\n\n2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.\n\n3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  '0BSD': (holder) => `BSD Zero Clause License\n\nCopyright (c) ${holder}\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
};

function personName(p) {
  if (!p) return null;
  if (typeof p === 'string') return p.replace(/\s*[<(].*$/, '');
  return p.name ?? null;
}

function sourceUrl(pkg) {
  const r = pkg.repository;
  let url = typeof r === 'string' ? r : r?.url;
  if (url) {
    url = url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
    if (/^github:/.test(url) || /^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url.replace(/^github:/, '')}`;
    return url;
  }
  return pkg.homepage ?? `https://www.npmjs.com/package/${pkg.name}`;
}

const filesLike = (dir, re) =>
  existsSync(dir)
    ? readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f)).filter((f) => statSync(f).isFile())
    : [];

/** One notice record per package directory that has a package.json. */
export function collectPackages(dirs) {
  const seen = new Map();
  for (const dir of dirs) {
    const manifest = path.join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    let pkg;
    try { pkg = readJson(manifest); } catch { continue; }
    if (!pkg.name) continue;
    const key = `${pkg.name}@${pkg.version ?? '0'}`;
    if (seen.has(key)) continue;
    const licenseFiles = filesLike(dir, /^(licen[cs]e|copying)(\.|-|$)/i).filter((f) => !/\.(js|mjs|cjs|ts|json)$/i.test(f));
    const noticeFiles = filesLike(dir, /^notice(\.|$)/i);
    const licenseTexts = licenseFiles.map((f) => readFileSync(f, 'utf8').trim()).filter(Boolean);
    seen.set(key, {
      name: pkg.name,
      version: pkg.version ?? '0',
      license: licenseId(pkg) === 'UNKNOWN' ? inferLicenseId(licenseTexts) : licenseId(pkg),
      author: personName(pkg.author),
      source: sourceUrl(pkg),
      licenseText: licenseTexts,
      noticeText: noticeFiles.map((f) => readFileSync(f, 'utf8').trim()).filter(Boolean),
    });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const RULE = '-'.repeat(72);

/** The notices document. Deterministic: no timestamps, sorted by name. */
export function renderNotices(packages, title) {
  const out = [];
  out.push(`THIRD-PARTY NOTICES for ${title}`);
  out.push('');
  out.push(
    'This artifact bundles the open-source packages listed below. Each entry',
    'reproduces the package\'s license and copyright notice (and its NOTICE',
    'file where one exists), as those licenses require. The packages remain',
    'under their own licenses; nothing here changes the license of this',
    'artifact itself.',
  );
  out.push('');
  out.push(`${packages.length} packages:`);
  for (const p of packages) out.push(`  ${p.name}@${p.version}  (${p.license})`);
  out.push('');
  for (const p of packages) {
    out.push(RULE);
    out.push(`${p.name}@${p.version}`);
    out.push(`License: ${p.license}`);
    if (p.author) out.push(`Author: ${p.author}`);
    out.push(`Source: ${p.source}`);
    out.push('');
    for (const n of p.noticeText) out.push('NOTICE:', n, '');
    if (p.licenseText.length) out.push(...p.licenseText.flatMap((t) => [t, '']));
    else if (CANONICAL[p.license]) {
      out.push(
        `(The package ships no license file; this is the ${p.license} notice it is published under.)`,
        '',
        CANONICAL[p.license](p.author ?? `the ${p.name} authors`),
        '',
      );
    } else {
      out.push(
        `The package ships no license file; it is distributed under ${p.license}`,
        `by ${p.author ?? 'its authors'}. See ${p.source} for the full text.`,
        '',
      );
    }
  }
  return out.join('\n') + '\n';
}

/** Build the notices for an artifact from bundles, module-id lists and extra package names. */
export function generateNotices({ root = process.cwd(), bundles = [], packageLists = [], add = [], title }) {
  const dirs = new Set();
  for (const b of bundles) for (const d of packageDirsFromBundle(path.resolve(root, b), root)) dirs.add(d);
  for (const f of packageLists) {
    const file = path.resolve(root, f);
    if (!existsSync(file)) throw new Error(`${f} not found - was the site built with bundledPackagesPlugin()?`);
    for (const d of packageDirsFromIds(readJson(file), root)) dirs.add(d);
  }
  for (const name of add) {
    const dir = path.resolve(root, 'node_modules', name);
    if (!existsSync(dir)) throw new Error(`--add ${name}: ${dir} does not exist`);
    dirs.add(dir);
  }
  const packages = collectPackages(dirs);
  if (packages.length === 0) throw new Error('no packages found - nothing to write');
  return { packages, text: renderNotices(packages, title) };
}

/**
 * Vite plugin: record which node_modules packages reach the browser, so
 * the notices can name exactly what shipped. Astro 7 builds through Vite
 * environments: the `client` environment is the JS the browser loads
 * (islands, `<script>` imports and their CSS); the server-side
 * environments only render HTML, but their stylesheet and font modules
 * do get emitted as assets, so those are taken from every environment.
 * Server-only code is not itself redistributed and is left out.
 */
export function bundledPackagesPlugin({ out = '.astro/bundled-packages.json' } = {}) {
  let root = process.cwd();
  const SHIPPED_FROM_SERVER = /\.(css|scss|sass|less|styl|woff2?|ttf|otf)$/i;
  return {
    name: 'sysspec-bundled-packages',
    configResolved(config) {
      root = config.root ?? root;
    },
    generateBundle() {
      const client = !this.environment || this.environment.name === 'client';
      const file = path.resolve(root, out);
      const ids = new Set(existsSync(file) ? readJson(file) : []);
      for (const raw of this.getModuleIds()) {
        if (raw.startsWith('\0')) continue;
        const id = raw.split('?')[0];
        if (!/[\\/]node_modules[\\/]/.test(id)) continue;
        if (client || SHIPPED_FROM_SERVER.test(id)) ids.add(id);
      }
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify([...ids].sort(), null, 1) + '\n');
    },
  };
}

function parseArgs(argv) {
  const o = { bundles: [], packageLists: [], add: [], root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--bundle') o.bundles.push(v());
    else if (a === '--packages') o.packageLists.push(v());
    else if (a === '--add') o.add.push(v());
    else if (a === '--root') o.root = path.resolve(v());
    else if (a === '--title') o.title = v();
    else if (a === '--out') o.out = v();
    else if (a === '--out-dir') o.outDir = v();
    else if (a === '--out-dir-env') o.outDirEnv = v();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.title) throw new Error('--title is required');
  if (o.outDirEnv && process.env[o.outDirEnv]) o.outDir = process.env[o.outDirEnv];
  if (o.outDir) o.out = path.join(o.outDir, OUT_NAME);
  if (!o.out) throw new Error('--out or --out-dir is required');
  return o;
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const { packages, text } = generateNotices(o);
    const out = path.resolve(o.root, o.out);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, text);
    const missing = packages.filter((p) => p.licenseText.length === 0).map((p) => p.name);
    console.log(`third-party notices: ${packages.length} packages -> ${path.relative(process.cwd(), out)}` +
      (missing.length ? ` (no license file shipped by: ${missing.join(', ')})` : ''));
  } catch (err) {
    console.error(`third-party-notices: ${err.message}`);
    process.exit(1);
  }
}
