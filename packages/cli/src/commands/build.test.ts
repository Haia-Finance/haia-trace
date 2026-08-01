import {
  existsSync,
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
    role: "client",
    context_id: "op-1",
    payload: {},
  },
  {
    event_id: "2",
    event_type: "x402.payment.submitted",
    occurred_at: "2026-07-23T12:00:01.000Z",
    seq: 1,
    adapter: "t",
    role: "client",
    context_id: "op-1",
    payload: {},
  },
  {
    event_id: "3",
    event_type: "x402.payment.responded",
    occurred_at: "2026-07-23T12:00:02.000Z",
    seq: 2,
    adapter: "t",
    role: "client",
    context_id: "op-1",
    payload: {},
  },
  {
    event_id: "4",
    event_type: "x402.payment.required",
    occurred_at: "2026-07-23T12:01:00.000Z",
    seq: 3,
    adapter: "t",
    role: "client",
    context_id: "op-2",
    payload: {},
  },
  {
    event_id: "5",
    event_type: "x402.settle.failed",
    occurred_at: "2026-07-23T12:01:01.000Z",
    seq: 4,
    adapter: "t",
    role: "client",
    context_id: "op-2",
    payload: {},
  },
];
const NDJSON = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

let dir: string;
let file: string;
let receiptsDir: string;
let eventsDir: string;

/** Write a run file into the events directory under a timestamp-style name. */
function writeRun(run: string, ndjson: string = NDJSON): string {
  const path = join(eventsDir, `${run}.ndjson`);
  writeFileSync(path, ndjson);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-build-"));
  file = join(dir, "run.ndjson");
  receiptsDir = join(dir, "receipts");
  eventsDir = join(dir, "events");
  mkdirSync(eventsDir);
  writeFileSync(file, NDJSON);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("haia-trace build", () => {
  it("assembles one receipt per operation and writes each to the store", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runs } = runBuild([file], { receiptsDir });

    const receipts = runs[0]?.receipts ?? [];
    expect(runs.map((r) => r.run)).toEqual(["run"]);
    expect(receipts.map((r) => r.operation.operation_id)).toEqual([
      "op-1",
      "op-2",
    ]);
    expect(receipts[0]?.completeness).toBe("full");
    expect(receipts[1]?.exceptions.map((e) => e.event_type)).toContain(
      "x402.settle.failed",
    );
    expect(readdirSync(receiptsDir).sort()).toEqual([
      "run~op-1.json",
      "run~op-2.json",
    ]);
  });

  it("is deterministic — the same run yields byte-identical receipt files (BR-4)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    runBuild([file], { receiptsDir: join(dir, "a") });
    runBuild([file], { receiptsDir: join(dir, "b") });
    expect(readFileSync(join(dir, "a", "run~op-1.json"), "utf8")).toBe(
      readFileSync(join(dir, "b", "run~op-1.json"), "utf8"),
    );
  });

  it("builds only the latest run in the events directory by default", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    writeRun("100");
    writeRun("300");
    writeRun("200");

    const { runs } = runBuild([], { eventsDir, receiptsDir });

    expect(runs.map((r) => r.run)).toEqual(["300"]);
    expect(readdirSync(receiptsDir).sort()).toEqual([
      "300~op-1.json",
      "300~op-2.json",
    ]);
  });

  it("builds every run in the events directory with --all, oldest first", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    writeRun("300");
    writeRun("100");
    writeRun("200");

    const { runs } = runBuild([], { all: true, eventsDir, receiptsDir });

    expect(runs.map((r) => r.run)).toEqual(["100", "200", "300"]);
    expect(runs.every((r) => r.receipts.length === 2)).toBe(true);
  });

  it("keeps two runs' identically-named operations apart", () => {
    // The reason runs are assembled separately: an adapter numbers operations
    // per session, so `op-1` in one run and `op-1` in the next are different
    // payments. Merged, they would fold into one receipt; keyed by operation
    // alone, the second would overwrite the first on disk.
    vi.spyOn(console, "log").mockImplementation(() => {});
    writeRun("100");
    writeRun("200");

    const { runs } = runBuild([], { all: true, eventsDir, receiptsDir });

    expect(runs.flatMap((r) => r.receipts).length).toBe(4);
    expect(readdirSync(receiptsDir).sort()).toEqual([
      "100~op-1.json",
      "100~op-2.json",
      "200~op-1.json",
      "200~op-2.json",
    ]);
  });

  it("builds exactly the run files it is given", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const a = writeRun("100");
    writeRun("200");
    const c = writeRun("300");

    const { runs } = runBuild([a, c], { eventsDir, receiptsDir });

    expect(runs.map((r) => r.run)).toEqual(["100", "300"]);
  });

  it("refuses --all alongside explicit run files", () => {
    expect(() =>
      runBuild([file], { all: true, eventsDir, receiptsDir }),
    ).toThrow(/--all/);
  });

  it("builds a file named twice only once", () => {
    // A glob plus one of its own members is still one run; building it twice
    // would double-count its operations in the summary and in --json.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const a = writeRun("100");

    const { runs } = runBuild([a, join(eventsDir, ".", "100.ndjson"), a], {
      eventsDir,
      receiptsDir,
    });

    expect(runs.map((r) => r.run)).toEqual(["100"]);
  });

  it("refuses two run files that share a name in different directories", () => {
    // Receipts are keyed by run *name*, so `a/run.ndjson` and `b/run.ndjson`
    // would write to the same files — the second silently replacing the first
    // while the report claimed both were built. Refusing is the only answer
    // that does not lose a receipt.
    const other = join(dir, "elsewhere");
    mkdirSync(other);
    const twin = join(other, "run.ndjson");
    writeFileSync(twin, NDJSON);

    expect(() => runBuild([file, twin], { receiptsDir })).toThrow(
      /both named "run"/,
    );
    // Nothing was written: the refusal comes before any receipt is stored.
    expect(existsSync(receiptsDir)).toBe(false);
  });

  it("names the run it failed on, and what it had already written", () => {
    // Each run is written as it is assembled, so a failure part-way through
    // leaves an updated store. An error that did not say so would let the
    // half-built directory read as untouched.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const good = writeRun("100");
    const missing = join(eventsDir, "200.ndjson");

    expect(() => runBuild([good, missing], { receiptsDir })).toThrow(
      /while building .*200\.ndjson.* already written/s,
    );
    expect(readdirSync(receiptsDir).sort()).toEqual([
      "100~op-1.json",
      "100~op-2.json",
    ]);
  });

  it("emits JSON nested per run, so identical operation ids stay apart", () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    writeRun("100");
    writeRun("200");

    runBuild([], { all: true, json: true, eventsDir, receiptsDir });

    const parsed = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(parsed.runs.map((r: { run: string }) => r.run)).toEqual([
      "100",
      "200",
    ]);
    expect(parsed.runs[0].receipts).toHaveLength(2);
    expect(parsed.runs[0].path).toBe(join(eventsDir, "100.ndjson"));
    expect(parsed.template.path).toContain("x402-buyer");
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

    const { runs } = runBuild([file], {
      template: "my-op",
      templatesDir,
      receiptsDir,
    });

    const receipts = runs[0]?.receipts ?? [];
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

    const result = runBuild([file], { templatesDir, receiptsDir });

    expect(result.template).toMatchObject({ path, origin: "local" });
    expect(log.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(path);
  });

  it("reports which run each set of verdicts came from", () => {
    // Two runs of one program yield receipts with identical operation ids and
    // different contents; the run file is what tells them apart on screen.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const a = writeRun("100");
    const b = writeRun("200");

    runBuild([], { all: true, eventsDir, receiptsDir });

    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain(a);
    expect(out).toContain(b);
  });

  it("throws when there is no run to build", () => {
    expect(() =>
      runBuild([], { eventsDir: join(dir, "empty"), receiptsDir }),
    ).toThrow(/no runs/);
  });

  it("registers under the `build` name on the program", () => {
    const program = new Command();
    buildCommand.register(program);
    expect(program.commands.map((c) => c.name())).toContain("build");
  });
});

describe("haia-trace build --status", () => {
  // op-1's happy path alone — a run whose every receipt is full.
  const ALL_FULL = `${events
    .filter((e) => e.context_id === "op-1")
    .map((e) => JSON.stringify(e))
    .join("\n")}\n`;

  it("shows only matching receipts, while writing every receipt to the store", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { runs } = runBuild([file], { receiptsDir, status: "partial" });

    // The report holds only the partial operation...
    expect(runs[0]?.receipts.map((r) => r.operation.operation_id)).toEqual([
      "op-2",
    ]);
    // ...but the store holds both: the filter narrows what is shown, never
    // what is written.
    expect(readdirSync(receiptsDir).sort()).toEqual([
      "run~op-1.json",
      "run~op-2.json",
    ]);
  });

  it("narrows --json's receipts too, leaving unassigned events untouched", () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    // A run-level event with no context_id — unassigned, so no verdict to match.
    const runLevel = {
      event_id: "9",
      event_type: "x402.settle.confirmed",
      occurred_at: "2026-07-23T12:02:00.000Z",
      seq: 5,
      adapter: "t",
      role: "client",
      payload: {},
    };
    writeFileSync(file, `${NDJSON}${JSON.stringify(runLevel)}\n`);

    runBuild([file], { json: true, receiptsDir, status: "full" });

    const parsed = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(
      parsed.runs[0].receipts.map(
        (r: { completeness: string }) => r.completeness,
      ),
    ).toEqual(["full"]);
    // The unfiltered count rides along, so a consumer can tell an empty
    // filtered `receipts` apart from a run that assembled nothing.
    expect(parsed.runs[0].assembled).toBe(2);
    expect(parsed.runs[0].unassigned).toHaveLength(1);
    expect(readdirSync(receiptsDir).sort()).toEqual([
      "run~op-1.json",
      "run~op-2.json",
    ]);
  });

  it("answers positively when the filter matches nothing in a run", () => {
    // Every receipt being the other status is a verdict on the run, not an
    // empty result — and it must not read like a run with no operations.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    writeFileSync(file, ALL_FULL);

    runBuild([file], { receiptsDir, status: "partial" });

    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("the only receipt in this run is full");
    expect(out).not.toContain("no operations found");
    expect(readdirSync(receiptsDir)).toEqual(["run~op-1.json"]);
  });

  it("keeps 'no operations found' for a run that assembled nothing", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    writeFileSync(file, "");

    runBuild([file], { receiptsDir, status: "partial" });

    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("no operations found in this run");
    expect(out).not.toContain("receipt in this run is");
  });

  it("rejects a status that is not a verdict, before anything is written", () => {
    expect(() =>
      runBuild([file], { receiptsDir, status: "done" as "full" }),
    ).toThrow(/invalid status: done — expected full or partial/);
    expect(existsSync(receiptsDir)).toBe(false);
  });

  it("prints the honest summary even with no terminal to spin on", () => {
    // Piped output — no TTY, no spinner — must carry the same guarantee: a
    // filtered log file still says what the run actually assembled.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    runBuild([file], { receiptsDir, status: "partial" });

    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain(
      "Assembled 2 receipts from 5 events — showing 1 partial",
    );
  });

  it("keeps the summary line honest about what was assembled", () => {
    // The spinner only runs on a TTY; fake one so the success line renders.
    // nanospinner draws on stderr, so that is where the line lands.
    const wasTTY = process.stdout.isTTY;
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.stdout.isTTY = true;

    try {
      runBuild([file], { receiptsDir, status: "partial" });
    } finally {
      process.stdout.isTTY = wasTTY;
    }

    // The head reports everything assembled and written; the filtered view is
    // only a suffix — a narrowed screen must not understate the run.
    const out = write.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toMatch(
      /Assembled 2 receipts from 5 events — showing 1 partial/,
    );
  });

  it("registers --status with both verdicts and no default", () => {
    const program = new Command();
    buildCommand.register(program);
    const build = program.commands.find((c) => c.name() === "build");
    const option = build?.options.find((o) => o.long === "--status");

    expect(option?.flags).toContain("full|partial");
    expect(option?.defaultValue).toBeUndefined();
  });
});

describe("haia-trace build --dir", () => {
  /** A Trace root with a run and a project template already in it. */
  function seedRoot(root: string): string {
    mkdirSync(join(root, "events"), { recursive: true });
    mkdirSync(join(root, "templates"), { recursive: true });
    const run = join(root, "events", "100.ndjson");
    writeFileSync(run, NDJSON);
    writeFileSync(
      join(root, "templates", "x402-buyer.yaml"),
      "template: x402-buyer\nversion: 1\nstages:\n  - id: outcome\n    required: true\n    match:\n      - event: x402.settle.failed\n",
    );
    return run;
  }

  it("moves events, receipts and templates together", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = join(dir, "my-trace");
    const run = seedRoot(root);

    const result = runBuild([], { dir: root });

    // Read the run from <root>/events...
    expect(result.runs.map((r) => r.path)).toEqual([run]);
    // ...judged against the template in <root>/templates...
    expect(result.template).toMatchObject({
      path: join(root, "templates", "x402-buyer.yaml"),
      origin: "local",
    });
    // ...and wrote the receipts to <root>/receipts.
    expect(readdirSync(join(root, "receipts")).sort()).toEqual([
      "100~op-1.json",
      "100~op-2.json",
    ]);
    // Nothing landed beside the default root.
    expect(existsSync(join(dir, "receipts"))).toBe(false);
  });

  it("lets --templates-dir outrank it, and only for templates", () => {
    // Templates are committed source; events and receipts are output. Pointing
    // runs at a scratch root must not orphan the templates.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = join(dir, "my-trace");
    seedRoot(root);
    const shared = join(dir, "ops");
    mkdirSync(shared);
    writeFileSync(
      join(shared, "x402-buyer.yaml"),
      "template: x402-buyer\nversion: 1\nstages:\n  - id: shared\n    required: true\n    match:\n      - event: x402.payment.required\n",
    );

    const result = runBuild([], { dir: root, templatesDir: shared });

    expect(result.template).toMatchObject({
      path: join(shared, "x402-buyer.yaml"),
      origin: "local",
    });
    expect(result.runs[0]?.receipts[0]?.stages.map((s) => s.id)).toEqual([
      "shared",
    ]);
    // The root still supplied the other two.
    expect(readdirSync(join(root, "receipts"))).toHaveLength(2);
  });

  it("still yields to an explicit run file, while receipts follow the root", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = join(dir, "my-trace");
    seedRoot(root);

    const result = runBuild([file], { dir: root });

    expect(result.runs.map((r) => r.run)).toEqual(["run"]);
    expect(readdirSync(join(root, "receipts")).sort()).toEqual([
      "run~op-1.json",
      "run~op-2.json",
    ]);
  });

  it("names the directory it searched when the root holds no runs", () => {
    expect(() => runBuild([], { dir: join(dir, "nowhere") })).toThrow(
      join(dir, "nowhere", "events"),
    );
  });

  it("registers --templates-dir with no default, so --dir can supply it", () => {
    // With a commander default, `templatesDir` is always set and "given" cannot
    // be told from "not given" — the override would silently beat --dir always.
    const program = new Command();
    buildCommand.register(program);
    const build = program.commands.find((c) => c.name() === "build");
    const option = (long: string) =>
      build?.options.find((o) => o.long === long);

    expect(option("--dir")?.defaultValue).toBe(".trace");
    expect(option("--templates-dir")).toBeDefined();
    expect(option("--templates-dir")?.defaultValue).toBeUndefined();
  });
});
