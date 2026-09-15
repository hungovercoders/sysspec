/** The strict ODCS stage of the data-contract gate.
 *
 * datacontract-cli's own lint is permissive - it passed the repo's three
 * contracts for as long as they carried a quality block the standard
 * rejects. The vendored JSON Schema is what actually holds a contract to
 * the version it declares, so these cases pin that behaviour with the
 * exact shape that used to slip through.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2019.js";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { odcsSchemaProblems } from "../src/lint.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(path.join(here, "..", "templates", "odcs", "odcs-json-schema-v3.2.0.json"), "utf-8"),
);
const ajv = new (Ajv as unknown as { default: any }).default({
  strict: false,
  allErrors: true,
  logger: false,
});
const validate = ajv.compile(schema);
const check = (yaml: string) => odcsSchemaProblems(parse(yaml), validate);

const contract = (property: string) =>
  [
    "apiVersion: v3.2.0",
    "kind: DataContract",
    "id: orders-events",
    "name: Order events",
    "version: 1.0.0",
    "schema:",
    "  - name: order_placed_events",
    "    logicalType: object",
    "    properties:",
    "      - name: total_pence",
    "        logicalType: integer",
    property,
  ].join("\n");

describe("odcs schema validation", () => {
  test("the shipped contracts satisfy the vendored schema", () => {
    for (const file of [
      "orders/data-contracts/orders-events.odcs.yaml",
      "payments/data-contracts/payments-events.odcs.yaml",
      "payments/data-contracts/payments-daily.odcs.yaml",
    ]) {
      const source = path.join(here, "..", "..", "specs", file);
      expect(check(readFileSync(source, "utf-8")), file).toEqual([]);
    }
  });

  test("the pre-3.2 quality shape is rejected, operator spelling included", () => {
    // `mustBeGreaterThanOrEqualTo` was never an ODCS operator - the
    // standard spells it `mustBeGreaterOrEqualTo` - and a free-form
    // `rule:` is not one of the four quality flavours.
    const problems = check(
      contract(
        ["        quality:", "          - rule: nonNegative", "            mustBeGreaterThanOrEqualTo: 0"].join(
          "\n",
        ),
      ),
    );
    expect(problems.join("\n")).toMatch(/unevaluated properties/);
  });

  test("the 3.2 sql flavour is accepted", () => {
    expect(
      check(
        contract(
          [
            "        quality:",
            "          - type: sql",
            "            description: totals are never negative",
            "            query: SELECT COUNT(*) FROM t WHERE total_pence < 0",
            "            mustBe: 0",
          ].join("\n"),
        ),
      ),
    ).toEqual([]);
  });

  test("an unknown apiVersion is rejected", () => {
    const problems = check(contract("        physicalType: bigint").replace("v3.2.0", "v9.9.9"));
    expect(problems.join("\n")).toMatch(/apiVersion/);
  });
});
