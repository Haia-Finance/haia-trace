import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { receiptPath, writeReceipt } from "../store.js";
import { runBuild } from "./build.js";
import { receiptCommand, runReceiptList, runReceiptShow } from "./receipt.js";

/** Two operations: one that completes, one whose settlement is never witnessed. */
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
    event_type: "x402.payment.submitted",
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
let eventsDir: string;
let receiptsDir: string;

/**
 * SGR escapes, built from the escape character's code rather than written into a
 * regex literal — a literal control character is a lint error, and a plausible typo.
 */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The text without colour, whatever the environment decided about colour. */
function plain(text: string): string {
  return text.replace(SGR, "");
}

/**
 * Run a command and capture each stream as the shell would see it, plus whatever it
 * returned.
 *
 * The two ways this CLI prints — `console.log` for text, `process.stdout.write` for
 * `--json` — reach one descriptor once it runs for real, so both are captured into
 * one buffer here, and `console.error` / `process.stderr.write` into the other.
 * Capturing them apart is what let a warning printed on stdout hide from a test
 * asserting that stdout held only JSON.
 *
 * (Under vitest the global `console` is replaced and does *not* route through
 * `process.stdout.write`, so spying the stream alone would miss every `console.log`.
 * Hence four spies rather than two.)
 *
 * Colour is stripped, because whether there is any is not ours to decide: picocolors
 * stands down for a non-terminal stdout but turns *on* when `CI` is set, so the same
 * assertion would pass locally and fail on a runner — `run 1721709600000` arrives as
 * `\e[2mrun\e[22m \e[1m1721709600000\e[22m` there. Asserting on the text means
 * asserting on the text.
 */
function capture<T>(run: () => T): { out: string; err: string; result: T } {
  const out: string[] = [];
  const err: string[] = [];
  // Both `console.log` and a direct `process.stdout.write` land on the same
  // descriptor in the real CLI, so both append to the same buffer — and in call
  // order, since it is one array. That is what makes "is stdout still valid JSON?"
  // an answerable question here; capturing them apart is what hid the answer before.
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(`${args.join(" ")}\n`);
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err.push(`${args.join(" ")}\n`);
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });

  const result = run();
  return { out: plain(out.join("")), err: plain(err.join("")), result };
}

/** What the command wrote to stdout — the listing, the rendered receipts, the JSON. */
function output(run: () => void): string {
  return capture(run).out;
}

/** Run a command for its return value, swallowing what it prints. */
function quiet<T>(run: () => T): T {
  return capture(run).result;
}

/** Build one run's receipts into the store, the way `build` writes them. */
function build(run: string): void {
  writeFileSync(join(eventsDir, `${run}.ndjson`), NDJSON);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  runBuild([join(eventsDir, `${run}.ndjson`)], { dir, receiptsDir });
  log.mockRestore();
}

/** Corrupt a receipt file in the store, as a write cut short would leave it. */
function corrupt(run: string, operation: string): void {
  // Creates the directory, so a test can model a store whose *only* content is
  // damaged — nothing readable ever having been written beside it.
  mkdirSync(receiptsDir, { recursive: true });
  writeFileSync(receiptPath(receiptsDir, run, operation), '{"operation": ');
}

/** Write a receipt with a chosen verdict, for the cases the fixture cannot produce. */
function store(run: string, operation: string, full: boolean): void {
  writeReceipt(
    {
      operation: {
        template: "x402-buyer",
        version: 1,
        operation_id: operation,
      },
      completeness: full ? "full" : "partial",
      stages: [
        { id: "challenge", required: true, state: "confirmed", events: ["e1"] },
      ],
      missing: [],
      exceptions: [],
      events: [],
    },
    run,
    receiptsDir,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-receipt-"));
  eventsDir = join(dir, "events");
  receiptsDir = join(dir, "receipts");
  mkdirSync(eventsDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("haia-trace receipt list", () => {
  it("lists exactly what build wrote", () => {
    // The round trip that matters: the write side and the read side agreeing on
    // how a receipt is named. Everything else here depends on it.
    build("1721709600000");
    const text = output(() => runReceiptList({ receiptsDir }));

    expect(text).toContain("run 1721709600000");
    expect(text).toContain("op-1");
    expect(text).toContain("FULL");
    expect(text).toContain("op-2");
    expect(text).toContain("PARTIAL");
    expect(text).toContain("2 receipts.");
  });

  it("groups several runs, oldest first", () => {
    build("1721712000000");
    build("1721709600000");
    const text = output(() => runReceiptList({ receiptsDir }));

    expect(text.indexOf("run 1721709600000")).toBeLessThan(
      text.indexOf("run 1721712000000"),
    );
    expect(text).toContain("4 receipts across 2 runs.");
  });

  it("narrows to one run with --run", () => {
    build("1721709600000");
    build("1721712000000");
    const text = output(() =>
      runReceiptList({ receiptsDir, run: "1721709600000" }),
    );

    expect(text).toContain("run 1721709600000");
    expect(text).not.toContain("run 1721712000000");
    expect(text).toContain("2 receipts.");
  });

  it("refuses a --run that is not in the store, naming the runs that are", () => {
    // Unlike an empty `--status`, a `--run` that matches nothing means the caller
    // named something absent — silence would read as "that run went fine".
    build("1721709600000");
    expect(() => runReceiptList({ receiptsDir, run: "nope" })).toThrow(
      /no receipts for run "nope".*runs in the store: 1721709600000/s,
    );
  });

  it("filters on the verdict with --status", () => {
    build("1721709600000");
    const partial = output(() =>
      runReceiptList({ receiptsDir, status: "partial" }),
    );
    expect(partial).toContain("op-2");
    expect(partial).not.toContain("op-1");

    const full = output(() => runReceiptList({ receiptsDir, status: "full" }));
    expect(full).toContain("op-1");
    expect(full).not.toContain("op-2");
  });

  it("counts only the receipts --run selected when a --status matches nothing", () => {
    // The denominator has to describe the search that ran. Reporting the whole
    // store against a one-run query implies the filter swept every run.
    store("run-a", "op-1", false);
    store("run-a", "op-2", false);
    store("run-b", "op-1", false);
    store("run-b", "op-2", false);

    const text = output(() =>
      runReceiptList({ receiptsDir, run: "run-a", status: "full" }),
    );

    expect(text).toContain("no full receipts among the 2 in run run-a.");
    expect(text).not.toContain("among the 4");
  });

  it("says so when a --status matches nothing, without calling the store empty", () => {
    // A store with no full receipts is a real answer about it, not an error and
    // not the same thing as a store that was never built into.
    writeReceipt(
      {
        operation: { template: "x402-buyer", version: 1, operation_id: "op-1" },
        completeness: "partial",
        stages: [],
        missing: [],
        exceptions: [],
        events: [],
      },
      "run",
      receiptsDir,
    );
    const text = output(() => runReceiptList({ receiptsDir, status: "full" }));
    expect(text).toMatch(/no full receipts among the 1 in/);
    expect(text).not.toMatch(/run `haia-trace build` first/);
  });

  it("points at build for an empty store, and does not throw", () => {
    // Nothing to list is the state every project starts in, so it is a hint at
    // exit 0 — `show` is where having nothing to show is a failure.
    const text = output(() => runReceiptList({ receiptsDir }));
    expect(text).toContain(receiptsDir);
    expect(text).toMatch(/run `haia-trace build` first/);
  });

  it("rejects a status that is not a verdict", () => {
    expect(() =>
      runReceiptList({
        receiptsDir,
        status: "done" as unknown as "full",
      }),
    ).toThrow(/invalid status.*full or partial/);
  });

  it("reports an unreadable file alongside the receipts it could read", () => {
    build("1721709600000");
    corrupt("1721709600000", "torn");
    const { out, err } = capture(() => runReceiptList({ receiptsDir }));

    expect(out).toContain("op-1");
    // The warning is a diagnostic about the store, not part of the answer, so it
    // goes to stderr — which is also what keeps `--json` parseable.
    expect(err).toMatch(/1 file in the store could not be read/);
    expect(err).toContain("torn");
    expect(out).not.toContain("could not be read");
  });

  it("reports unreadable files even when --run refuses the query", () => {
    // Refusing a query is no reason to withhold the reason it might have failed.
    build("1721709600000");
    corrupt("1721709600000", "torn");
    const { err } = capture(() => {
      expect(() => runReceiptList({ receiptsDir, run: "nope" })).toThrow();
    });
    expect(err).toMatch(/could not be read/);
  });

  it("does not call a wholly corrupt store empty", () => {
    // "run build first" would send someone to rebuild a store that already holds
    // their receipts; the fix is to look at why the files will not read.
    corrupt("1721709600000", "op-1");
    const { out, err } = capture(() => runReceiptList({ receiptsDir }));

    expect(out).toMatch(/no readable receipts in .*1 file could not be read/);
    expect(out).not.toMatch(/run `haia-trace build` first/);
    expect(err).toMatch(/could not be read/);
  });

  it("names the corrupt run rather than reporting an empty store for --run", () => {
    // And does not list the run among "runs in the store" while denying it holds
    // any receipts — the run is there, its receipts just will not read.
    corrupt("1721709600000", "op-1");
    expect(() => runReceiptList({ receiptsDir, run: "1721709600000" })).toThrow(
      /no readable receipts for run "1721709600000".*its 1 receipt could not be read/s,
    );
  });

  it("keeps --json parseable when the store holds an unreadable file", () => {
    // The regression this whole helper rewrite exists for: a warning printed on
    // stdout splices a line in ahead of the document and `jq` fails.
    build("1721709600000");
    corrupt("1721709600000", "torn");
    const { out, err } = capture(() =>
      runReceiptList({ receiptsDir, json: true }),
    );

    const parsed = JSON.parse(out);
    expect(parsed.receipts).toHaveLength(2);
    // And the damage still reaches the machine consumer, through the document.
    expect(parsed.unreadable).toHaveLength(1);
    expect(parsed.unreadable[0].run).toBe("1721709600000");
    expect(err).toMatch(/could not be read/);
  });

  it("emits an index — not whole receipts — with --json", () => {
    // `list` answers "what is in the store?", so it carries the fields a reader
    // filters on. Embedding every receipt's events would make it `show` twice.
    build("1721709600000");
    const parsed = JSON.parse(
      output(() => runReceiptList({ receiptsDir, json: true })),
    );

    expect(parsed.unreadable).toEqual([]);
    expect(parsed.receipts).toHaveLength(2);
    expect(parsed.receipts[0]).toMatchObject({
      run: "1721709600000",
      operation: "op-1",
      completeness: "full",
      template: "x402-buyer",
    });
    expect(parsed.receipts[0]).not.toHaveProperty("events");
    expect(parsed.receipts[0]).not.toHaveProperty("stages");
  });
});

describe("haia-trace receipt show", () => {
  it("renders the whole of the most recent run when given no operation", () => {
    build("1721709600000");
    build("1721712000000");
    const result = quiet(() =>
      runReceiptShow(undefined, { receiptsDir, json: true }),
    );

    // Names being start timestamps, the greatest is the newest — the same rule
    // core applies to run files, so "the run I just built" needs no flag.
    expect(result.run).toBe("1721712000000");
    expect(result.receipts).toHaveLength(2);
  });

  it("renders one operation, stages and all", () => {
    build("1721709600000");
    const text = output(() => runReceiptShow("op-2", { receiptsDir }));

    expect(text).toContain("run: 1721709600000");
    expect(text).toContain("op-2");
    expect(text).toContain("PARTIAL");
    // The distinction from `list`: `show` prints the verdict in full.
    expect(text).toContain("settlement");
    expect(text).toContain("not confirmed");
    expect(text).toContain("operation not complete");
  });

  it("shows an operation from an earlier run with --run", () => {
    build("1721709600000");
    build("1721712000000");
    const result = quiet(() =>
      runReceiptShow("op-1", {
        receiptsDir,
        run: "1721709600000",
        json: true,
      }),
    );

    // An operation id is unique only within its run, so both halves address it.
    expect(result.run).toBe("1721709600000");
    expect(result.receipts).toHaveLength(1);
  });

  it("finds a receipt whose id had to be escaped into the file name", () => {
    // The reason `show` is more than `cat`: nobody can name this file by hand.
    const id = "https://api.example.com/data";
    writeReceipt(
      {
        operation: { template: "x402-buyer", version: 1, operation_id: id },
        completeness: "full",
        stages: [
          {
            id: "challenge",
            required: true,
            state: "confirmed",
            events: ["1"],
          },
        ],
        missing: [],
        exceptions: [],
        events: [],
      },
      "runs/2026",
      receiptsDir,
    );

    const result = quiet(() =>
      runReceiptShow(id, { receiptsDir, run: "runs/2026", json: true }),
    );
    expect(result.receipts[0]?.operation.operation_id).toBe(id);
  });

  it("refuses an operation the run does not hold, naming the ones it does", () => {
    build("1721709600000");
    expect(() => runReceiptShow("op-9", { receiptsDir })).toThrow(
      /no receipt for "op-9" in run "1721709600000".*op-1, op-2/s,
    );
  });

  it("shows an operation named by an unambiguous prefix", () => {
    // The ids adapters mint are not typed from memory — x402's are uuids — so a
    // prefix is how the command is reached for in practice.
    const id = "9b5e7013-2b5e-4f1e-89b3-4287bb321412";
    writeReceipt(
      {
        operation: { template: "x402-buyer", version: 1, operation_id: id },
        completeness: "full",
        stages: [],
        missing: [],
        exceptions: [],
        events: [],
      },
      "runs/2026",
      receiptsDir,
    );

    const result = quiet(() =>
      runReceiptShow("9b5e", { receiptsDir, run: "runs/2026", json: true }),
    );
    expect(result.receipts[0]?.operation.operation_id).toBe(id);
  });

  it("refuses a prefix that matches several operations, asking for more of it", () => {
    // Distinct from "no such receipt": the caller needs more characters, not
    // different ones, and showing whichever sorted first would answer about a
    // payment they never named.
    build("1721709600000");
    writeReceipt(
      {
        operation: { template: "x402-buyer", version: 1, operation_id: "op-3" },
        completeness: "partial",
        stages: [],
        missing: [],
        exceptions: [],
        events: [],
      },
      "1721709600000",
      receiptsDir,
    );

    expect(() => runReceiptShow("op-", { receiptsDir })).toThrow(
      /"op-" matches 3 operations in run "1721709600000".*use more of the id: op-1, op-2, op-3/s,
    );
  });

  it("names the run's operations even when --run was given", () => {
    // The docs promise this unconditionally, so the lookup must not have a path
    // that skips the scan and can only offer a command to run instead.
    build("1721709600000");
    expect(() =>
      runReceiptShow("op-9", { receiptsDir, run: "1721709600000" }),
    ).toThrow(/operations in that run: op-1, op-2/);
  });

  it("refuses to present an older run when the newest one is unreadable", () => {
    // The worst way to be wrong about a payment: a clean, passing verdict from the
    // previous run, offered as the answer to "how did the run I just built go?".
    build("1721709600000");
    corrupt("1721712000000", "op-1");

    const { err } = capture(() => {
      expect(() => runReceiptShow(undefined, { receiptsDir })).toThrow(
        /no readable receipts for run "1721712000000".*could not be read/s,
      );
    });
    expect(err).toMatch(/could not be read/);
  });

  it("carries the unreadable files into the JSON a machine reads", () => {
    // A spend policy reading `{ run, receipts }` sees stdout only. Without this
    // field, a partly skipped store looks like a complete answer.
    build("1721709600000");
    corrupt("1721709600000", "torn");
    const { out } = capture(() =>
      runReceiptShow(undefined, { receiptsDir, json: true }),
    );

    const parsed = JSON.parse(out);
    expect(parsed.receipts).toHaveLength(2);
    expect(parsed.unreadable).toHaveLength(1);
  });

  it("reports unreadable files on the --run + operation lookup too", () => {
    // This pair used to take a fast path that read one file and never scanned, so
    // it alone showed a damaged store as intact.
    build("1721709600000");
    corrupt("1721709600000", "torn");
    const { err } = capture(() =>
      runReceiptShow("op-1", { receiptsDir, run: "1721709600000" }),
    );
    expect(err).toMatch(/could not be read/);
  });

  it("fails on an empty store, unlike list", () => {
    // The caller asked for a verdict and there is none: exiting 0 here would let
    // a missing receipt read as one that had nothing to report.
    expect(() => runReceiptShow(undefined, { receiptsDir })).toThrow(
      /no receipts in .*run `haia-trace build` first/s,
    );
  });

  it("keeps one JSON shape whether or not an operation is named", () => {
    // A shape that changed with the argument count would break any script.
    build("1721709600000");
    const all = JSON.parse(
      output(() => runReceiptShow(undefined, { receiptsDir, json: true })),
    );
    const one = JSON.parse(
      output(() => runReceiptShow("op-1", { receiptsDir, json: true })),
    );

    expect(Object.keys(all).sort()).toEqual(["receipts", "run", "unreadable"]);
    expect(Object.keys(one).sort()).toEqual(["receipts", "run", "unreadable"]);
    expect(all.receipts).toHaveLength(2);
    expect(one.receipts).toHaveLength(1);
    // The full receipt, events and all — the document, where `list` is the index.
    expect(one.receipts[0].stages.length).toBeGreaterThan(0);
    expect(one.receipts[0].events).toHaveLength(3);
  });
});

describe("haia-trace receipt --dir", () => {
  it("reads the receipts directory under the root build wrote to", () => {
    // One flag moves the whole store, so `build --dir X` and `receipt list
    // --dir X` have to land on the same directory with no second flag.
    writeFileSync(join(eventsDir, "1721709600000.ndjson"), NDJSON);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    runBuild([], { dir });
    log.mockRestore();

    const text = output(() => runReceiptList({ dir }));
    expect(text).toContain("run 1721709600000");
    expect(text).toContain("2 receipts.");
  });
});

describe("registration", () => {
  it("registers `receipt` with the `list` and `show` subcommands", () => {
    const program = new Command();
    receiptCommand.register(program);

    const receipt = program.commands.find((c) => c.name() === "receipt");
    expect(receipt).toBeDefined();
    expect(receipt?.commands.map((c) => c.name()).sort()).toEqual([
      "list",
      "show",
    ]);
  });

  it("requires a subcommand — `receipt` alone has no action of its own", () => {
    // Commander shows the subcommand help for a parent with no action handler,
    // which is what makes a bare `haia-trace receipt` self-explaining.
    const program = new Command();
    receiptCommand.register(program);
    const receipt = program.commands.find((c) => c.name() === "receipt");
    expect(receipt?.registeredArguments).toHaveLength(0);
  });

  it("takes an optional operation on `show`, so a bare show is valid", () => {
    const program = new Command();
    receiptCommand.register(program);
    const show = program.commands
      .find((c) => c.name() === "receipt")
      ?.commands.find((c) => c.name() === "show");
    expect(show?.registeredArguments[0]?.required).toBe(false);
  });
});
