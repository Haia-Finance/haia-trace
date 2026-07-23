import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Receipt } from "@usehaia/trace-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeReceipt } from "./store.js";

const receipt = (operationId: string): Receipt => ({
  operation: { template: "x402-payment", version: 1, operation_id: operationId },
  completeness: "partial",
  stages: [{ id: "intent", required: true, state: "confirmed", events: ["e1"] }],
  missing: [],
  exceptions: [],
  events: [],
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeReceipt", () => {
  it("writes <operation_id>.json and returns the path", () => {
    const path = writeReceipt(receipt("op-1"), dir);
    expect(basename(path)).toBe("op-1.json");
    expect(JSON.parse(readFileSync(path, "utf8")).operation.operation_id).toBe("op-1");
  });

  it("is deterministic — the same receipt yields byte-identical content (BR-4)", () => {
    const a = writeReceipt(receipt("op-1"), join(dir, "a"));
    const b = writeReceipt(receipt("op-1"), join(dir, "b"));
    expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8"));
  });

  it("sanitizes an operation id that is unsafe as a file name", () => {
    // A URL-ish context id must not escape the directory or break on Windows.
    const path = writeReceipt(receipt("https://api.example.com/data"), dir);
    expect(basename(path)).not.toContain("/");
    expect(basename(path)).not.toContain(":");
    expect(basename(path).endsWith(".json")).toBe(true);
  });
});
