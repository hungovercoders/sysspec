/** The null service - a falsifiability gate for bound feature suites.
 *
 * Strict binding proves every step is bound; it cannot prove a binding does
 * anything. A suite is falsifiable only if every scenario fails against a
 * service that proves nothing, so this module serves the most convincing
 * wrong answer - 200 {} to every method on every path, no events - runs the
 * suite against it, and is red unless zero scenarios pass. The response is
 * deliberately an ordinary 200 rather than an error: against a weird reply
 * a status-code-only scenario would fail and look honest; against the
 * plausible empty answer it passes, and gets flagged too.
 */

import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createServer, Server } from "node:http";

function serve(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      req.resume(); // drain any body
      const body = "{}";
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
      });
      res.end(body);
    });
    server.on("error", (exc) => {
      console.log(`null run: cannot bind 127.0.0.1:${port} (${exc.message}) - pass --port`);
      reject(new Error("bind failed"));
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** Scenarios in a cucumber-format results document where every step
 * passed - the ones the null service could not make fail. Returns
 * [passed descriptions, total scenarios seen]. */
export function passedScenarios(doc: any[]): [string[], number] {
  const passed: string[] = [];
  let total = 0;
  for (const feature of doc) {
    for (const element of feature.elements ?? []) {
      if ((element.type ?? "scenario") !== "scenario") continue;
      total += 1;
      const steps: any[] = element.steps ?? [];
      if (steps.length && steps.every((s) => s.result?.status === "passed")) {
        const name = String(element.name ?? "").trim() || "(unnamed)";
        passed.push(`${feature.uri ?? "?"}:${element.line ?? "?"} ${name}`);
      }
    }
  }
  return [passed, total];
}

export function check(results: string): number {
  let text: string;
  try {
    text = readFileSync(results, "utf-8");
  } catch {
    console.log(
      `null run: ${results} was not written - the suite command must` +
        " emit cucumber-format JSON there (e.g. --format json:<file>);" +
        " a missing result is never a pass",
    );
    return 1;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (exc) {
    console.log(
      `null run: ${results} is not cucumber-format JSON (${exc instanceof Error ? exc.message : exc})`,
    );
    return 1;
  }
  if (!Array.isArray(doc)) {
    console.log(`null run: ${results} is not a cucumber-format feature array`);
    return 1;
  }
  const [passed, total] = passedScenarios(doc);
  if (!total) {
    console.log(`null run: no scenarios in ${results} - wrong results file?`);
    return 1;
  }
  if (passed.length) {
    console.log(
      `null run: ${passed.length} of ${total} scenarios passed against a` +
        " service that answers 200 {} to everything - these bindings" +
        " prove nothing:",
    );
    for (const line of passed) console.log(`  ${line}`);
    return 1;
  }
  console.log(
    `null run: ${total} scenarios, 0 passed against the null service` +
      " - the suite is falsifiable",
  );
  return 0;
}

export async function runNull(
  port: number,
  results: string,
  timeout: number,
  cmd: string[],
): Promise<number> {
  if (cmd.length === 0) {
    console.log("null run: no suite command after --");
    return 1;
  }
  rmSync(results, { force: true });
  let server: Server;
  try {
    server = await serve(port);
  } catch {
    return 1;
  }
  console.log(
    `null service answering 200 {} on http://127.0.0.1:${port}` +
      " - every scenario must fail",
  );
  try {
    const returncode = await new Promise<number | null>((resolve) => {
      const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null); // timed out
      }, timeout * 1000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(1);
      });
    });
    if (returncode === null) {
      console.log(
        `null run: suite exceeded ${timeout}s against the null` +
          " service - likely an event await with no client timeout",
      );
      return 1;
    }
    console.log(`null run: suite exited ${returncode} (non-zero expected here)`);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
  return check(results);
}
