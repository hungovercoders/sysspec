/** End-to-end wiring tests: the committed dist bundle spoken to by a real
 * MCP client over both transports.
 */

import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const specsDir = path.join(repoRoot, "specs");
const distEntry = path.join(here, "..", "dist", "stdio.mjs");

const TOOL_NAMES = [
  "list_services",
  "get_service",
  "get_artifact",
  "get_message_schema",
  "get_acceptance_criteria",
  "trace_channel",
  "search_specs",
  "list_skills",
  "get_skill",
];

describe.skipIf(!existsSync(distEntry))("dist/stdio.mjs end to end", () => {
  test("stdio: lists the nine tools and answers a call", async () => {
    const client = new Client({ name: "e2e", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distEntry],
      env: { ...process.env, SPECS_DIR: specsDir },
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      for (const tool of tools) {
        expect(tool.description, `${tool.name} has a description`).toBeTruthy();
      }
      const result: any = await client.callTool({ name: "list_services", arguments: {} });
      const services = JSON.parse(result.content[0].text);
      expect(services.map((s: any) => s.name)).toContain("orders");
      const miss: any = await client.callTool({
        name: "get_service",
        arguments: { name: "nope" },
      });
      expect(miss.isError).toBe(true);
      expect(miss.content[0].text).toContain("No service 'nope'");
      // Skills are baked into the committed dist: nothing on disk backs
      // this call, only the bundle itself.
      const skill: any = await client.callTool({
        name: "get_skill",
        arguments: { name: "sysspec" },
      });
      const served = JSON.parse(skill.content[0].text);
      expect(served.content).toContain("Working against the system specs");
    } finally {
      await client.close();
    }
  });

  describe("http transport", () => {
    const port = 18931;
    let child: ChildProcess;
    beforeAll(async () => {
      child = spawn(
        process.execPath,
        [distEntry, "--transport", "http", "--port", String(port)],
        { env: { ...process.env, SPECS_DIR: specsDir }, stdio: ["ignore", "ignore", "pipe"] },
      );
      await new Promise<void>((resolve, reject) => {
        child.stderr!.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("serving")) resolve();
        });
        child.on("exit", (code) => reject(new Error(`server exited early: ${code}`)));
      });
    });
    afterAll(() => {
      child?.kill();
    });

    test("serves stateless streamable HTTP", async () => {
      const client = new Client({ name: "e2e-http", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      );
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
        const result: any = await client.callTool({
          name: "trace_channel",
          arguments: { address: "orders.placed.v2" },
        });
        const traced = JSON.parse(result.content[0].text);
        expect(traced.produced_by).toEqual(["orders"]);
      } finally {
        await client.close();
      }
    });

    test("info page on / and 404 elsewhere", async () => {
      const info = await fetch(`http://127.0.0.1:${port}/`);
      expect(info.status).toBe(200);
      expect((await info.json()).endpoint).toBe("/mcp");
      const missing = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(missing.status).toBe(404);
    });
  });
});
