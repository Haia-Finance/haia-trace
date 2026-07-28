import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCommand, runBuild } from "./build.js";

// One full happy-path operation (op-1) and one with an observed fault (op-2).
const events = [
  {
    event_id: "1",
    event_type: "x402.payment.required",
    occurred_at: "2026-07-23T12:00:00.000Z",
    seq: 0,
    adapter: "t",
    context_id: "op-1",
    payload: {},
  },
  {
    event_id: "2",
    event_type: "x402.payment.submitted",
    occurred_at: "2026-07-23T12:00:01.000Z",
    seq: 1,
    adapter: "t",
    context_id: "op-1",
    payload: {},
  },
  {
    event_id: "3",
    event_type: "x402.payment.responded",
    occurred_at: "2026-07-23T12:00:02.000Z",
    seq: 2,
    adapter: "t",
    context_id: "op-1",
    payload: {},
  },
  {
    event_id: "4",
    event_type: "x402.payment.required",
    occurred_at: "2026-07-23T12:01:00.000Z",
    seq: 3,
    adapter: "t",
    context_id: "op-2",
    payload: {},
  },
  {
    event_id: "5",
    event_type: "x402.settle.failed",
    occurred_at: "2026-07-23T12:01:01.000Z",
    seq: 4,
    adapter: "t",
    context_id: "op-2",
    payload: {},
  },
];
const NDJSON = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

let dir: string;
let file: string;
let receiptsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-build-"));
  file = join(dir, "run.ndjson");
  receiptsDir = join(dir, "receipts");
  writeFileSync(file, NDJSON);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("haia-trace build", () => {
  it("assembles one receipt per operation and writes each to the store", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { receipts } = runBuild(file, { receiptsDir });

    expect(receipts.map((r) => r.operation.operation_id)).toEqual([
      "op-1",
      "op-2",
    ]);
    expect(receipts[0]?.completeness).toBe("full");
    expect(receipts[1]?.exceptions.map((e) => e.event_type)).toContain(
      "x402.settle.failed",
    );
    expect(readdirSync(receiptsDir).sort()).toEqual(["op-1.json", "op-2.json"]);
  });

  it("is deterministic — the same run yields byte-identical receipt files (BR-4)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    runBuild(file, { receiptsDir: join(dir, "a") });
    runBuild(file, { receiptsDir: join(dir, "b") });
    expect(readFileSync(join(dir, "a", "op-1.json"), "utf8")).toBe(
      readFileSync(join(dir, "b", "op-1.json"), "utf8"),
    );
  });

  it("builds against a project's own template, not just the built-in set", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const templatesDir = join(dir, "templates");
    mkdirSync(templatesDir);
    // A shape no shipped template has: one stage, closed by the settle failure
    // that makes op-2 partial under x402-buyer.
    writeFileSync(
      join(templatesDir, "my-op.yaml"),
      "template: my-op\nversion: 1\nstages:\n  - id: outcome\n    required: true\n    match:\n      - event: x402.settle.failed\n",
    );

    const { receipts } = runBuild(file, {
      template: "my-op",
      templatesDir,
      receiptsDir,
    });

    expect(receipts.map((r) => r.operation.template)).toEqual([
      "my-op",
      "my-op",
    ]);
    expect(receipts[1]?.stages.map((s) => s.id)).toEqual(["outcome"]);
    expect(receipts[1]?.completeness).toBe("full");
  });

  it("reports which template file the verdicts were assembled against", () => {
    // The receipt records the template's declared name but not the file that
    // declared it, so two machines can produce different verdicts from the same
    // run and the same command. The path is the only thing that tells them apart.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const templatesDir = join(dir, "templates");
    mkdirSync(templatesDir);
    const path = join(templatesDir, "x402-buyer.yaml");
    writeFileSync(
      path,
      "template: x402-buyer\nversion: 1\nstages:\n  - id: outcome\n    required: true\n    match:\n      - event: x402.settle.failed\n",
    );

    const result = runBuild(file, { templatesDir, receiptsDir });

    expect(result.template).toMatchObject({ path, origin: "local" });
    expect(log.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(path);
  });

  it("throws when there is no run to build", () => {
    expect(() =>
      runBuild(undefined, { eventsDir: join(dir, "empty"), receiptsDir }),
    ).toThrow(/no runs/);
  });

  it("registers under the `build` name on the program", () => {
    const program = new Command();
    buildCommand.register(program);
    expect(program.commands.map((c) => c.name())).toContain("build");
  });
});
