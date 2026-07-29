import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Receipt } from "@usehaia/trace-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeReceipt } from "./store.js";

const receipt = (operationId: string): Receipt => ({
  operation: {
    template: "x402-buyer",
    version: 1,
    operation_id: operationId,
  },
  completeness: "partial",
  stages: [
    { id: "challenge", required: true, state: "confirmed", events: ["e1"] },
  ],
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
  it("writes <run>~<operation_id>.json and returns the path", () => {
    const path = writeReceipt(receipt("op-1"), "1721709600000", dir);
    expect(basename(path)).toBe("1721709600000~op-1.json");
    expect(JSON.parse(readFileSync(path, "utf8")).operation.operation_id).toBe(
      "op-1",
    );
  });

  it("keeps the same operation id from two runs apart", () => {
    // An adapter may number operations per session, so `op-1` in one run and
    // `op-1` in the next are different payments. Keyed by operation alone, the
    // second would silently overwrite the first.
    const a = writeReceipt(receipt("op-1"), "1721709600000", dir);
    const b = writeReceipt(receipt("op-1"), "1721712000000", dir);
    expect(a).not.toBe(b);
    expect(readdirSync(dir).sort()).toEqual([
      "1721709600000~op-1.json",
      "1721712000000~op-1.json",
    ]);
  });

  it("is deterministic — the same receipt yields byte-identical content (BR-4)", () => {
    const a = writeReceipt(receipt("op-1"), "run", join(dir, "a"));
    const b = writeReceipt(receipt("op-1"), "run", join(dir, "b"));
    expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8"));
  });

  it("sanitizes a run id or operation id that is unsafe as a file name", () => {
    // A URL-ish context id must not escape the directory or break on Windows.
    const path = writeReceipt(
      receipt("https://api.example.com/data"),
      "runs/2026",
      dir,
    );
    expect(basename(path)).not.toContain("/");
    expect(basename(path)).not.toContain(":");
    expect(basename(path).endsWith(".json")).toBe(true);
    // Sanitizing must not let a path segment escape into the directory tree.
    expect(readdirSync(dir)).toEqual([basename(path)]);
  });

  it("never maps two different ids onto one file", () => {
    // Sanitizing has to be injective, and the separator has to be a character
    // no sanitized segment can contain. Replacing every unsafe character with
    // the same `_` fails both: these four pairs would collapse onto two files
    // and silently overwrite each other.
    const pairs = [
      ["a", "b"],
      ["a_", "_b"],
      ["a~b", "c"],
      ["a", "b/c"],
      ["a", "b c"],
    ];
    const written = pairs.map(([run, op]) =>
      writeReceipt(receipt(String(op)), String(run), dir),
    );
    expect(new Set(written).size).toBe(pairs.length);
    expect(readdirSync(dir)).toHaveLength(pairs.length);
  });
});
