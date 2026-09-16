/** Building and serving the spec-derived mock bundle.
 *
 * The Node half of the mock engine: it reads the specs and the example
 * artifacts, refuses anything the engine could only serve by guessing, and
 * hands the result either to a `node:http` server (`mocks serve`) or to a
 * file a Worker can bake in (`mocks bundle`). The dispatch itself lives in
 * mock-engine.ts, which stays free of node builtins so both runtimes share
 * exactly one implementation.
 *
 * Refusals are the point. Microcks does things this engine does not -
 * body-aware dispatch, mock templating, its own UI and test runner - so an
 * example relying on one is a build error here rather than a mock that
 * quietly serves something the Microcks stack would not.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { parse } from "yaml";
import { info, serviceDirs, specDocs, test as smokeTest } from "./mocks.js";
import {
  describe,
  dispatch,
  matchChannel,
  PUBLISH_INTERVAL_MS,
  replay,
  restBase,
  wsPath,
  type MockBundle,
  type MockCase,
  type MockChannel,
  type MockRoute,
  type MockService,
} from "./mock-engine.js";
import { Exit } from "./util.js";

type Dict = Record<string, any>;

function templated(value: string, where: string): void {
  if (value.includes("{{")) {
    throw new Exit(
      `${where}: mock templating is not supported by the served mocks - the ` +
        "example must hold a literal payload, or the mock would serve " +
        "something the Microcks stack does not",
    );
  }
}

const specKey = (title: string, version: string) => JSON.stringify([title, version]);

/** Example artifacts for one service directory, indexed by the spec they
 * claim. `metadata.name`/`version` must name a spec document, or the
 * examples describe a surface no contract has. */
function examplesFor(mocksDir: string, service: string): Map<string, [string, Dict]> {
  let files: string[] = [];
  try {
    files = readdirSync(mocksDir)
      .filter((f) => f.startsWith(`${service}.`) && f.endsWith(".examples.yaml"))
      .sort()
      .map((f) => path.join(mocksDir, f));
  } catch {
    files = [];
  }
  const index = new Map<string, [string, Dict]>();
  for (const file of files) {
    const doc = (parse(readFileSync(file, "utf-8")) ?? {}) as Dict;
    const meta: Dict = doc.metadata ?? {};
    if (!meta.name || !meta.version) {
      throw new Exit(`${file}: metadata.name and metadata.version are required`);
    }
    index.set(specKey(String(meta.name), String(meta.version)), [file, doc]);
  }
  return index;
}

function splitParams(
  params: Dict,
  routePath: string,
): [Record<string, string>, Record<string, string>] {
  const pathParams: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    if (routePath.includes(`{${name}}`)) pathParams[name] = String(value);
    else query[name] = String(value);
  }
  return [pathParams, query];
}

function restRoutes(doc: Dict, examples: Dict, file: string): MockRoute[] {
  const paths: Dict = doc.paths ?? {};
  const routes: MockRoute[] = [];
  for (const [op, rawCases] of Object.entries<Dict>(examples.operations ?? {})) {
    const spaceAt = op.indexOf(" ");
    if (spaceAt === -1) {
      throw new Exit(`${file}: '${op}' is not a REST operation ('<METHOD> <path>')`);
    }
    const method = op.slice(0, spaceAt).toUpperCase();
    const opPath = op.slice(spaceAt + 1);
    const pathItem: Dict = paths[opPath] ?? {};
    if (!(method.toLowerCase() in pathItem)) {
      throw new Exit(
        `${file}: '${op}' is not in the contract - the specs are the authority, ` +
          "so an example cannot introduce an operation the OpenAPI document " +
          "does not declare",
      );
    }
    const cases: MockCase[] = [];
    for (const [name, body] of Object.entries<Dict>(rawCases ?? {})) {
      const request: Dict = body?.request ?? {};
      const response: Dict = body?.response ?? {};
      const payload =
        response.body === undefined || response.body === null ? null : String(response.body);
      if (payload !== null) templated(payload, `${file}: '${op}' [${name}]`);
      const [pathParams, query] = splitParams(request.parameters ?? {}, opPath);
      cases.push({
        name,
        pathParams,
        query,
        status: parseInt(String(response.status ?? 200), 10),
        mediaType: String(response.mediaType ?? "application/json"),
        body: payload,
      });
    }
    if (cases.length > 1) {
      // Microcks dispatches these by URI; two cases a URI cannot tell apart
      // would make the served response a coin toss.
      const seen = new Set<string>();
      for (const c of cases) {
        const key = JSON.stringify([c.pathParams, c.query]);
        if (key === "[{},{}]" || seen.has(key)) {
          throw new Exit(
            `${file}: '${op}' has cases that dispatch identically ([${c.name}]) - ` +
              "cases on one operation must differ by path or query parameter",
          );
        }
        seen.add(key);
      }
    }
    routes.push({
      method,
      path: opPath,
      segments: opPath.split("/").filter((s) => s.length > 0),
      cases,
    });
  }
  return routes;
}

function sendOperationNames(doc: Dict): string[] {
  return Object.entries<Dict>(doc.operations ?? {})
    .filter(([, op]) => op?.action === "send")
    .map(([name]) => name);
}

function eventChannels(doc: Dict, examples: Dict, file: string): MockChannel[] {
  const sends = new Set(sendOperationNames(doc));
  const channels: MockChannel[] = [];
  for (const [op, rawCases] of Object.entries<Dict>(examples.operations ?? {})) {
    if (!op.startsWith("SEND ")) {
      throw new Exit(`${file}: '${op}' is not an event operation ('SEND <operation>')`);
    }
    const operation = op.slice(5);
    if (!sends.has(operation)) {
      throw new Exit(
        `${file}: '${op}' is not in the contract - the AsyncAPI document declares ` +
          "no send operation by that name",
      );
    }
    const messages: string[] = [];
    for (const [name, body] of Object.entries<Dict>(rawCases ?? {})) {
      const payload = body?.eventMessage?.payload;
      if (payload === undefined || payload === null) {
        throw new Exit(`${file}: '${op}' [${name}] has no eventMessage.payload`);
      }
      templated(String(payload), `${file}: '${op}' [${name}]`);
      messages.push(String(payload));
    }
    channels.push({ operation, messages });
  }
  return channels;
}

export interface BuildResult {
  bundle: MockBundle;
  /** Specs the bundle serves nothing for. Authoring in progress is not an
   * error here, but the smoke suite stays red until they are covered. */
  gaps: string[];
}

export function buildBundle(
  only: string | null,
  specsDir: string,
  mocksDir: string,
  source?: string,
): BuildResult {
  const services: MockService[] = [];
  const gaps: string[] = [];
  for (const dir of serviceDirs(specsDir, only)) {
    const name = path.basename(dir);
    const examples = examplesFor(mocksDir, name);
    const used = new Set<string>();
    const take = (title: string, version: string): [string, Dict] | null => {
      const key = specKey(title, version);
      const hit = examples.get(key);
      if (hit) used.add(key);
      return hit ?? null;
    };

    for (const [specFile, doc] of specDocs(dir, "openapi")) {
      const [title, version] = info(doc);
      const hit = take(title, version);
      if (!hit) {
        gaps.push(`${specFile}: no REST examples for ${title} ${version}`);
        continue;
      }
      const [file, examplesDoc] = hit;
      services.push({
        title,
        version,
        kind: "rest",
        service: name,
        routes: restRoutes(doc, examplesDoc, file),
        channels: [],
      });
    }

    for (const [specFile, doc] of specDocs(dir, "asyncapi")) {
      const [title, version] = info(doc);
      const hit = take(title, version);
      if (!hit) {
        gaps.push(`${specFile}: no event examples for ${title} ${version}`);
        continue;
      }
      const [file, examplesDoc] = hit;
      const channels = eventChannels(doc, examplesDoc, file);
      for (const op of sendOperationNames(doc)) {
        if (!channels.some((c) => c.operation === op)) {
          gaps.push(`${file}: no example for SEND ${op}`);
        }
      }
      services.push({ title, version, kind: "events", service: name, routes: [], channels });
    }

    for (const [key, [file]] of examples) {
      if (used.has(key)) continue;
      const [title, version] = JSON.parse(key) as [string, string];
      throw new Exit(
        `${file}: metadata names '${title}' ${version}, which no spec in ${dir} ` +
          "declares - examples belong to a contract, so the name and version " +
          "must match a spec's info.title and info.version",
      );
    }
  }
  if (services.length === 0) {
    throw new Exit(`no mockable specs found under ${specsDir}/ - nothing to serve`);
  }
  return { bundle: { version: 1, ...(source ? { source } : {}), services }, gaps };
}

function drain(req: IncomingMessage): void {
  // Dispatch is by URI; the body is read only so the socket can be reused.
  req.resume();
}

export async function serve(
  bundle: MockBundle,
  port: number,
  host: string,
  intervalMs = PUBLISH_INTERVAL_MS,
): Promise<Server> {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ noServer: true });

  const server = createServer((req, res) => {
    drain(req);
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const out = dispatch(bundle, (req.method ?? "GET").toUpperCase(), url.pathname, query);
    res.writeHead(out.status, {
      ...out.headers,
      "Content-Length": String(Buffer.byteLength(out.body)),
    });
    res.end(req.method === "HEAD" ? undefined : out.body);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const matched = matchChannel(bundle, url.pathname);
    if (!matched) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const [, channel] = matched;
    wss.handleUpgrade(req, socket, head, (ws) => {
      // The minion publishes on an interval; this sends the first example on
      // connect as well, which changes when a subscriber sees a payload but
      // never which payload it sees.
      const next = replay(channel);
      const publish = () => {
        const message = next();
        if (message !== null) ws.send(message);
      };
      publish();
      const timer = setInterval(publish, intervalMs);
      ws.on("close", () => clearInterval(timer));
      ws.on("error", () => clearInterval(timer));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}

function banner(bundle: MockBundle, origin: string, gaps: string[]): void {
  console.log(`sysspec mocks serving on ${origin}`);
  for (const s of bundle.services) {
    if (s.kind === "rest") {
      console.log(`  REST   ${origin}${restBase(s)} (${s.routes.length} operations)`);
      for (const r of s.routes) console.log(`         ${r.method} ${r.path}`);
    } else {
      for (const c of s.channels) {
        console.log(`  EVENT  ${origin.replace(/^http/, "ws")}${wsPath(s, c)}`);
      }
    }
  }
  for (const gap of gaps) console.log(`  note: ${gap}`);
}

export async function runServe(
  only: string | null,
  specsDir: string,
  mocksDir: string,
  port: number,
  host: string,
): Promise<number> {
  const { bundle, gaps } = buildBundle(only, specsDir, mocksDir);
  const server = await serve(bundle, port, host);
  const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  banner(bundle, `http://${shown}:${port}`, gaps);
  console.log("Ctrl-C to stop");
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.close(() => resolve());
      // Keep-alive sockets and subscribed WebSockets would hold the close
      // open; the mocks keep no state worth draining.
      server.closeAllConnections?.();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

/** The parity gate: the example smoke suite, run against the served
 * bundle instead of the Microcks stack. Both engines answer the same
 * assertions or one of them is wrong, and an ephemeral port keeps it
 * runnable anywhere, CI and a developer's laptop alike. */
export async function runParity(
  only: string | null,
  specsDir: string,
  mocksDir: string,
  port: number,
): Promise<number> {
  const { bundle, gaps } = buildBundle(only, specsDir, mocksDir);
  const server = await serve(bundle, port, "127.0.0.1");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`mocks parity: the example suite, against the served bundle at ${origin}`);
  for (const gap of gaps) console.log(`  note: ${gap}`);
  try {
    return await smokeTest(only, specsDir, mocksDir, origin, origin);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function runBundle(
  only: string | null,
  specsDir: string,
  mocksDir: string,
  out: string,
  source: string | null,
): number {
  const { bundle, gaps } = buildBundle(only, specsDir, mocksDir, source ?? undefined);
  writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
  console.log(`wrote ${out} (${describe(bundle).services.length} mock services)`);
  for (const gap of gaps) console.log(`  note: ${gap}`);
  return 0;
}
