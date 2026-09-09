/** Microcks mock-stack orchestration, driven entirely by the specs.
 *
 * Every service's specs and examples are loaded into Microcks; contract
 * tests and smoke tests are derived from the manifests, the specs and the
 * example files - nothing here knows any service by name.
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Exit, run } from "./util.js";
import { parse } from "yaml";

type Dict = Record<string, any>;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function composeFile(arg: string | null): string {
  if (arg) return arg;
  const local = path.join("mocks", "docker-compose.yml");
  if (isFile(local)) return local;
  // Fall back to the compose file shipped with the CLI, materialized where
  // both `up` and `down` can find it again.
  const target = path.join(".sysspec", "docker-compose.yml");
  mkdirSync(path.dirname(target), { recursive: true });
  const bundled = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates",
    "docker-compose.yml",
  );
  copyFileSync(bundled, target);
  return target;
}

function dc(file: string, ...args: string[]): void {
  const res = run(["docker", "compose", "-f", file, ...args], { inherit: true });
  if (res.status !== 0) {
    throw new Exit(`docker compose ${args.join(" ")} failed (exit ${res.status})`);
  }
}

async function http(
  method: string,
  url: string,
  body: BodyInit | null = null,
  headers: Record<string, string> = {},
  timeoutSeconds = 10,
): Promise<[number, string]> {
  const resp = await fetch(url, {
    method,
    body,
    headers,
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  });
  return [resp.status, await resp.text()];
}

async function upload(microcksUrl: string, file: string, main: boolean): Promise<void> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([readFileSync(file)], { type: "application/x-yaml" }),
    path.basename(file),
  );
  const [status, out] = await http(
    "POST",
    `${microcksUrl}/api/artifact/upload?mainArtifact=${main ? "true" : "false"}`,
    form,
    {},
    30,
  );
  if (status >= 300) {
    throw new Exit(`upload failed (${status}) for ${file}: ${out.slice(0, 200)}`);
  }
  console.log(`loaded ${file}`);
}

export function serviceDirs(specsDir: string, only: string | null): string[] {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(specsDir)
      .sort()
      .map((d) => path.join(specsDir, d))
      .filter((d) => isFile(path.join(d, "service.yaml")))
      .filter((d) => !only || path.basename(d) === only);
  } catch {
    dirs = [];
  }
  if (dirs.length === 0) {
    throw new Exit(`no services matching '${only || "*"}' under ${specsDir}/`);
  }
  return dirs;
}

function specDocs(serviceDir: string, kind: string): [string, Dict][] {
  const dir = path.join(serviceDir, kind);
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
  return files.map((f) => [f, (parse(readFileSync(f, "utf-8")) ?? {}) as Dict]);
}

export function info(doc: Dict): [string, string] {
  const i: Dict = doc.info ?? {};
  if (!i.title || !i.version) {
    throw new Exit("spec is missing info.title or info.version - Microcks needs both");
  }
  return [String(i.title), String(i.version)];
}

function sendOperations(doc: Dict): string[] {
  return Object.entries<Dict>(doc.operations ?? {})
    .filter(([, op]) => op?.action === "send")
    .map(([name]) => name);
}

export function up(compose: string): number {
  dc(compose, "up", "-d", "--wait");
  return 0;
}

export function down(compose: string): number {
  dc(compose, "down");
  return 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function load(
  only: string | null,
  specsDir: string,
  mocksDir: string,
  microcksUrl: string,
  minionUrl: string,
  compose: string,
): Promise<number> {
  up(compose);
  for (const d of serviceDirs(specsDir, only)) {
    for (const kind of ["asyncapi", "openapi"]) {
      for (const [spec] of specDocs(d, kind)) {
        await upload(microcksUrl, spec, true);
      }
    }
    let exampleFiles: string[] = [];
    try {
      exampleFiles = readdirSync(mocksDir)
        .filter((f) => f.startsWith(`${path.basename(d)}.`) && f.endsWith(".examples.yaml"))
        .sort()
        .map((f) => path.join(mocksDir, f));
    } catch {
      exampleFiles = [];
    }
    for (const examples of exampleFiles) {
      await upload(microcksUrl, examples, false);
    }
  }
  dc(compose, "restart", "async-minion");
  for (let i = 0; i < 30; i++) {
    try {
      // A liveness gate, not a health assertion: any HTTP response proves
      // the minion's server is back up after the restart (the uber image
      // answers /health with a non-200), so only network errors and
      // timeouts keep the loop waiting.
      const [status] = await http("GET", `${minionUrl}/health`, null, {}, 3);
      console.log(`async-minion http up (after ${i + 1} checks, /health -> ${status})`);
      return 0;
    } catch {
      await sleep(2000);
    }
  }
  throw new Exit("async-minion not responding after 60s (no HTTP response from /health)");
}

async function runTest(
  microcksUrl: string,
  serviceId: string,
  runner: string,
  endpoint: string,
  timeoutMs: number,
  operation: string | null,
): Promise<void> {
  const label = `[${runner}${operation ? ` / ${operation}` : ""}]`;
  console.log(`contract test: ${serviceId} ${label} -> ${endpoint}`);
  const payload: Dict = {
    serviceId,
    testEndpoint: endpoint,
    runnerType: runner,
    timeout: timeoutMs,
  };
  if (operation) payload.filteredOperations = [operation];
  const [status, out] = await http(
    "POST",
    `${microcksUrl}/api/tests`,
    JSON.stringify(payload),
    { "Content-Type": "application/json" },
  );
  const testId = status < 300 ? (JSON.parse(out || "{}").id ?? null) : null;
  if (!testId) {
    throw new Exit(
      `could not start the test - is '${serviceId}' loaded? (sysspec mocks load)`,
    );
  }
  const deadline = Date.now() + timeoutMs + 60_000;
  let result: Dict;
  for (;;) {
    const [st, body] = await http("GET", `${microcksUrl}/api/tests/${testId}`);
    if (st >= 300) throw new Exit(`could not read test ${testId}`);
    result = JSON.parse(body);
    if (!result.inProgress) break;
    if (Date.now() > deadline) throw new Exit(`test ${testId} never finished`);
    await sleep(2000);
  }

  let exchanges = 0;
  for (const testCase of result.testCaseResults ?? []) {
    console.log(`  ${testCase.success ? "PASS" : "FAIL"}  ${testCase.operationName}`);
    for (const step of testCase.testStepResults ?? []) {
      exchanges += 1;
      const detail = step.message ? ` - ${step.message}` : "";
      console.log(
        `        ${step.success ? "ok  " : "FAIL"} ${step.requestName || "-"}${detail}`,
      );
    }
  }
  if (!result.success) {
    throw new Exit(
      `${serviceId} does not conform to its spec - full detail at ${microcksUrl} > Tests`,
    );
  }
  if (exchanges === 0) {
    throw new Exit(
      `${serviceId}: the runner validated nothing - a green test over ` +
        "zero exchanges is a failure",
    );
  }
  console.log(`contract ok: ${serviceId} - ${exchanges} exchanges validated`);
}

export async function contract(
  only: string | null,
  specsDir: string,
  microcksUrl: string,
  restEndpoint: string | null,
  asyncEndpoint: string | null,
): Promise<number> {
  for (const d of serviceDirs(specsDir, only)) {
    for (const [, doc] of specDocs(d, "openapi")) {
      const [title, version] = info(doc);
      const encoded = title.replaceAll(" ", "+");
      await runTest(
        microcksUrl,
        `${title}:${version}`,
        "OPEN_API_SCHEMA",
        restEndpoint || `http://microcks:8080/rest/${encoded}/${version}`,
        20000,
        null,
      );
    }
    for (const [, doc] of specDocs(d, "asyncapi")) {
      const [title, version] = info(doc);
      const encoded = title.replaceAll(" ", "+");
      for (const op of sendOperations(doc)) {
        // A real WebSocket endpoint gets the operation appended,
        // mirroring the minion's own per-operation mock URLs: each
        // send operation is validated on its own path (a mixed
        // stream would fail one operation's schema), and the URL
        // always carries the path the Microcks WS consumer requires.
        // Broker endpoints (kafka://, mqtt://, amqp://) are used
        // verbatim - there the topic lives in the endpoint and a
        // shared topic is a legitimate topology.
        let endpoint: string;
        if (asyncEndpoint && /^wss?:\/\//.test(asyncEndpoint)) {
          endpoint = `${asyncEndpoint.replace(/\/+$/, "")}/${op}`;
        } else if (asyncEndpoint) {
          endpoint = asyncEndpoint;
        } else {
          endpoint = `ws://async-minion:8081/api/ws/${encoded}/${version}/${op}`;
        }
        await runTest(
          microcksUrl, `${title}:${version}`, "ASYNC_API_SCHEMA", endpoint, 15000, `SEND ${op}`,
        );
      }
    }
  }
  return 0;
}

/** Structural match: every expected value must appear in the response.
 * Mock templating (values containing '{{') is not asserted. */
export function bodyMatches(expected: any, actual: any): boolean {
  if (typeof expected === "string" && expected.includes("{{")) return true;
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    return (
      actual !== null &&
      typeof actual === "object" &&
      !Array.isArray(actual) &&
      Object.entries(expected).every(([k, v]) => k in actual && bodyMatches(v, actual[k]))
    );
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((e, i) => bodyMatches(e, actual[i]))
    );
  }
  return expected === actual;
}

async function restSmoke(
  docTitle: string,
  version: string,
  examples: Dict,
  microcksUrl: string,
): Promise<void> {
  const base = `${microcksUrl}/rest/${docTitle.replaceAll(" ", "+")}/${version}`;
  for (const [op, cases] of Object.entries<Dict>(examples.operations ?? {})) {
    const spaceAt = op.indexOf(" ");
    const method = spaceAt === -1 ? op : op.slice(0, spaceAt);
    const opPath = spaceAt === -1 ? "" : op.slice(spaceAt + 1);
    for (const [caseName, caseBody] of Object.entries<Dict>(cases ?? {})) {
      const request: Dict = caseBody.request ?? {};
      const params: Dict = { ...(request.parameters ?? {}) };
      let urlPath = opPath;
      for (const key of Object.keys(params)) {
        if (urlPath.includes(`{${key}}`)) {
          urlPath = urlPath.replaceAll(`{${key}}`, String(params[key]));
          delete params[key];
        }
      }
      let url = base + urlPath;
      const remaining = Object.entries(params);
      if (remaining.length) {
        url += "?" + remaining.map(([k, v]) => `${k}=${v}`).join("&");
      }
      const body = request.body;
      const [status, out] = await http(method, url, body ?? null, request.headers ?? {});
      const expected: Dict = caseBody.response ?? {};
      const want = parseInt(String(expected.status ?? 200), 10);
      if (status !== want) {
        throw new Exit(`${op} [${caseName}]: expected ${want}, got ${status}`);
      }
      const expectedBody = expected.body;
      if (expectedBody && String(expected.mediaType ?? "").includes("json")) {
        if (!bodyMatches(JSON.parse(expectedBody), JSON.parse(out))) {
          throw new Exit(`${op} [${caseName}]: response does not match the example`);
        }
      }
      console.log(`rest mock ok: ${op} [${caseName}] -> ${status}`);
    }
  }
}

/** The payload schema of the (single) message on an operation's channel. */
function payloadSchema(doc: Dict, opName: string): Dict | null {
  const op: Dict = (doc.operations ?? {})[opName] ?? {};
  const channelKey = String(op?.channel?.$ref ?? "").split("/").pop() ?? "";
  const channel: Dict = (doc.channels ?? {})[channelKey] ?? {};
  for (const name of Object.keys(channel.messages ?? {})) {
    const message: Dict = (doc.components?.messages ?? {})[name] ?? {};
    if ("payload" in message) return message.payload;
  }
  return null;
}

async function wsReceiveOne(url: string, timeoutMs: number): Promise<string> {
  const { default: WebSocket } = await import("ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Exit(`no message within ${timeoutMs / 1000}s on ${url}`));
    }, timeoutMs);
    ws.on("message", (data) => {
      clearTimeout(timer);
      ws.close();
      resolve(data.toString());
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Lenient schema validation: draft chosen by $schema (2020-12
 * fallback), unknown keywords tolerated, formats not enforced. */
async function validateSchema(instance: unknown, schema: Dict): Promise<void> {
  const declared = String(schema.$schema ?? "");
  const draft7 =
    declared.includes("draft-07") || declared.includes("draft-06") || declared.includes("draft-04");
  // ajv ships CJS; unwrap whichever default shape the loader hands back.
  const mod: any = draft7 ? await import("ajv") : await import("ajv/dist/2020.js");
  const Ajv = mod.Ajv ?? mod.default?.default ?? mod.default;
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validate = ajv.compile(schema);
  if (!validate(instance)) {
    throw new Exit(
      `event payload does not validate: ${ajv.errorsText(validate.errors)}`,
    );
  }
}

async function eventSmoke(doc: Dict, minionUrl: string): Promise<void> {
  const [title, version] = info(doc);
  const wsBase = minionUrl.replace("http://", "ws://").replace("https://", "wss://");
  for (const op of sendOperations(doc)) {
    const url = `${wsBase}/api/ws/${title.replaceAll(" ", "+")}/${version}/${op}`;
    const message = JSON.parse(await wsReceiveOne(url, 20_000));
    const schema = payloadSchema(doc, op);
    if (schema !== null) await validateSchema(message, schema);
    console.log(`event mock ok: ${title}/${op} - envelope validates against the spec`);
  }
}

export async function test(
  only: string | null,
  specsDir: string,
  mocksDir: string,
  microcksUrl: string,
  minionUrl: string,
): Promise<number> {
  let checked = 0;
  for (const d of serviceDirs(specsDir, only)) {
    for (const [, doc] of specDocs(d, "openapi")) {
      const examplesPath = path.join(mocksDir, `${path.basename(d)}.rest.examples.yaml`);
      if (!isFile(examplesPath)) {
        console.log(`no REST examples for ${path.basename(d)} (${examplesPath}) - skipping`);
        continue;
      }
      const [title, version] = info(doc);
      await restSmoke(
        title,
        version,
        (parse(readFileSync(examplesPath, "utf-8")) ?? {}) as Dict,
        microcksUrl,
      );
      checked += 1;
    }
    for (const [, doc] of specDocs(d, "asyncapi")) {
      await eventSmoke(doc, minionUrl);
      checked += 1;
    }
  }
  if (checked === 0) throw new Exit("mocks test validated nothing - no specs found");
  return 0;
}

export async function watch(channel: string, minionUrl: string): Promise<number> {
  const { default: WebSocket } = await import("ws");
  const wsBase = minionUrl.replace("http://", "ws://").replace("https://", "wss://");
  const ws = new WebSocket(`${wsBase}/api/ws/${channel}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  console.log(`watching ${channel} (Ctrl-C to stop)`);
  ws.on("message", (data) => console.log(data.toString()));
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      ws.close();
      resolve();
    });
    ws.on("close", () => resolve());
  });
  return 0;
}
