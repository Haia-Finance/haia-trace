import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Receipt } from "@usehaia/trace-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findReceipt,
  latestRun,
  listReceipts,
  receiptPath,
  writeReceipt,
} from "./store.js";

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

describe("listReceipts", () => {
  it("reads back what writeReceipt wrote, with the run its name records", () => {
    // The run id lives only in the file name — the Receipt contract has no run
    // field — so recovering it is the read side's whole job.
    writeReceipt(receipt("op-1"), "1721709600000", dir);
    const { receipts, unreadable } = listReceipts(dir);

    expect(unreadable).toEqual([]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.run).toBe("1721709600000");
    expect(receipts[0]?.operation).toBe("op-1");
    expect(receipts[0]?.receipt.operation.operation_id).toBe("op-1");
  });

  it("restores ids that had to be escaped into the file name", () => {
    // The pair from the sanitizing test above, read back: a `_`-replacement
    // scheme could store these but never recover them, which is what makes the
    // fixed-width percent escape worth its ugliness.
    writeReceipt(receipt("https://api.example.com/data"), "runs/2026", dir);
    const { receipts } = listReceipts(dir);

    expect(receipts[0]?.run).toBe("runs/2026");
    expect(receipts[0]?.operation).toBe("https://api.example.com/data");
  });

  it("sorts by run then operation, oldest run first", () => {
    writeReceipt(receipt("op-2"), "1721712000000", dir);
    writeReceipt(receipt("op-1"), "1721712000000", dir);
    writeReceipt(receipt("op-1"), "1721709600000", dir);

    // Run ids are start timestamps, so name order is time order — the ordering
    // `receipt show` relies on to mean "the most recent run" by the last entry.
    expect(
      listReceipts(dir).receipts.map((e) => `${e.run}~${e.operation}`),
    ).toEqual([
      "1721709600000~op-1",
      "1721712000000~op-1",
      "1721712000000~op-2",
    ]);
  });

  it("reads an empty store from a directory that does not exist", () => {
    // A project that has not built yet has no receipts — the normal case, and the
    // opposite of the built-in templates directory, whose absence is a break.
    expect(listReceipts(join(dir, "nope"))).toEqual({
      receipts: [],
      unreadable: [],
    });
  });

  it("reports an unreadable receipt instead of failing the whole listing", () => {
    writeReceipt(receipt("op-1"), "run", dir);
    writeFileSync(receiptPath(dir, "run", "torn"), '{"operation": ');

    const { receipts, unreadable } = listReceipts(dir);

    // The good receipt still lists: one bad file must not cost the answer to
    // "what is in the store?".
    expect(receipts.map((e) => e.operation)).toEqual(["op-1"]);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.path).toContain("torn");
    expect(unreadable[0]?.reason).toMatch(/invalid receipt/);
  });

  it("reports a file that parses but is not a receipt", () => {
    // Truncation is not the only way a store goes stale: a receipt written by an
    // older CLI can parse cleanly and still lack what a renderer reads.
    writeFileSync(
      receiptPath(dir, "run", "shapeless"),
      JSON.stringify({ operation: { template: "t" }, completeness: "full" }),
    );
    const { receipts, unreadable } = listReceipts(dir);

    expect(receipts).toEqual([]);
    expect(unreadable[0]?.reason).toMatch(/not a receipt/);
  });

  it("rejects malformed elements inside the arrays, not just the arrays", () => {
    // The whole point of the guard is that a bad file fails with a sentence naming
    // it. Checking only `Array.isArray` would pass each of these through to a
    // renderer, which reads `stage.id.length` and dies on an anonymous TypeError.
    const base = {
      operation: { template: "t", version: 1 },
      completeness: "full",
      stages: [],
      missing: [],
      exceptions: [],
      events: [],
    };
    const broken = {
      "stage-without-id": { ...base, stages: [{ state: "confirmed" }] },
      "stage-not-an-object": { ...base, stages: ["challenge"] },
      "gap-without-expected": { ...base, missing: [{ stage: "settlement" }] },
      "fault-without-type": { ...base, exceptions: [{ event_id: "e9" }] },
    };
    for (const [name, value] of Object.entries(broken)) {
      writeFileSync(receiptPath(dir, "run", name), JSON.stringify(value));
    }

    const { receipts, unreadable } = listReceipts(dir);
    expect(receipts).toEqual([]);
    expect(unreadable).toHaveLength(Object.keys(broken).length);
    for (const file of unreadable) {
      expect(file.reason).toMatch(/not a receipt/);
    }
  });

  it("records which run an unreadable file belongs to", () => {
    // The name parses even when the contents do not, and the run is what says
    // whether the damage is in the run just built or an old one.
    writeFileSync(receiptPath(dir, "1721712000000", "op-1"), "{");
    const { unreadable } = listReceipts(dir);

    expect(unreadable[0]?.run).toBe("1721712000000");
    expect(unreadable[0]?.operation).toBe("op-1");
  });

  it("passes over files it never wrote", () => {
    writeReceipt(receipt("op-1"), "run", dir);
    // No separator, two separators, and not JSON at all: none is a name this
    // store produces, so none is its business to report as broken.
    writeFileSync(join(dir, "notes.json"), "not ours\n");
    writeFileSync(join(dir, "a~b~c.json"), "not ours\n");
    writeFileSync(join(dir, "run~op-2.txt"), "not ours\n");
    mkdirSync(join(dir, "archive.json"));

    const { receipts, unreadable } = listReceipts(dir);
    expect(receipts.map((e) => e.operation)).toEqual(["op-1"]);
    expect(unreadable).toEqual([]);
  });
});

describe("findReceipt", () => {
  it("finds a receipt by the ids it was written under", () => {
    // Including one that had to be escaped: the file name is not constructible by
    // hand, so this lookup is the only reliable way to the receipt.
    const id = "https://api.example.com/data";
    writeReceipt(receipt(id), "runs/2026", dir);

    const found = findReceipt(listReceipts(dir), "runs/2026", id);
    expect(found?.receipt.operation.operation_id).toBe(id);
    expect(found?.run).toBe("runs/2026");
  });

  it("returns null for a receipt that is not there", () => {
    expect(findReceipt(listReceipts(dir), "run", "op-1")).toBeNull();
  });

  it("does not match an operation from a different run", () => {
    // An operation id is unique only within its run, so both halves have to match
    // or `show --run` would answer with another run's verdict.
    writeReceipt(receipt("op-1"), "run-a", dir);
    const stored = listReceipts(dir);
    expect(findReceipt(stored, "run-b", "op-1")).toBeNull();
    expect(findReceipt(stored, "run-a", "op-1")).not.toBeNull();
  });
});

describe("latestRun", () => {
  it("names the greatest run id, comparing as core sorts run files", () => {
    // Not `localeCompare`: collation would order `Run-2` and `run-1` the other way
    // round from core's plain sort, so `build` and `show` would disagree on which
    // run is the most recent one.
    writeReceipt(receipt("op-1"), "run-1", dir);
    writeReceipt(receipt("op-1"), "Run-2", dir);

    const runs = ["Run-2", "run-1"].sort();
    expect(latestRun(listReceipts(dir))).toBe(runs[runs.length - 1]);
  });

  it("counts a run whose receipts are all unreadable", () => {
    // The newest run being corrupt is exactly when naming an older one does harm:
    // `show` would present a previous run's passing verdict as the current one.
    writeReceipt(receipt("op-1"), "1721709600000", dir);
    writeFileSync(receiptPath(dir, "1721712000000", "op-1"), "{");

    expect(latestRun(listReceipts(dir))).toBe("1721712000000");
  });

  it("is null for an empty store", () => {
    expect(latestRun(listReceipts(dir))).toBeNull();
  });
});
