/// <reference types="node" />
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileReader,
  createFileWriter,
  createRunWriter,
  listRunFiles,
  readLatestRun,
  runIdFromPath,
} from "./node.js";
import { createRecorder } from "./recorder.js";

const rec = createRecorder({
  adapter: "trace-x402",
  now: () => "2026-07-23T00:00:00.000Z",
  newId: () => "evt-fixed",
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-sink-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createRunWriter", () => {
  it("names the file with the start timestamp and no illegal characters", () => {
    const writer = createRunWriter(dir, { now: () => 1721709600000 });
    expect(writer.path).toBe(join(dir, "1721709600000.ndjson"));
    // The file *name* must be filesystem-safe on every OS — notably no ':' (which
    // an ISO timestamp would carry, and which Windows forbids). Check the basename,
    // not the full path, since the temp dir itself contains a drive-letter colon.
    expect(basename(writer.path)).not.toContain(":");
  });

  it("creates the file eagerly, so an event-less run is still visible", () => {
    const writer = createRunWriter(dir, { now: () => 1 });
    expect(readFileSync(writer.path, "utf8")).toBe("");
  });

  it("refuses a missing or empty directory with a message that names the fix", () => {
    // The fail-open policy covers the disk, not the caller: without a directory
    // there is no run file to fail open to. An untyped caller gets no compile
    // error, so the message has to carry the migration from the older form.
    for (const bad of [undefined, null, "", "   "]) {
      expect(() =>
        createRunWriter(bad as unknown as string, { now: () => 1 }),
      ).toThrow(/createRunWriter requires a run directory/);
    }
    // And it is the argument that is rejected, not the disk — `onError` is for
    // I/O and must not be handed a caller mistake it cannot act on.
    const reported: unknown[] = [];
    expect(() =>
      createRunWriter("", { onError: (err) => reported.push(err) }),
    ).toThrow(TypeError);
    expect(reported).toEqual([]);
  });

  it("creates the run directory when it does not exist yet", () => {
    // A producer names a directory, not a directory that already exists — the
    // first run of a fresh checkout must not have to mkdir first.
    const nested = join(dir, "deep", "events");
    const writer = createRunWriter(nested, { now: () => 1 });
    expect(writer.path).toBe(join(nested, "1.ndjson"));
    expect(readFileSync(writer.path, "utf8")).toBe("");
  });

  it("round-trips events through the file", () => {
    const writer = createRunWriter(dir, { now: () => 1 });
    const a = rec.event({
      event_type: "x402.payment.required",
      payload: {},
      context_id: "op-1",
    });
    const b = rec.event({
      event_type: "x402.settle.ok",
      payload: {},
      role: "server",
    });
    writer.write(a);
    writer.write(b);
    expect(createFileReader(writer.path).read()).toEqual([a, b]);
  });
});

describe("createFileWriter", () => {
  it("appends across two writers sharing one run file", () => {
    const path = join(dir, "shared.ndjson");
    const client = createFileWriter(path);
    const server = createFileWriter(path);
    client.write(rec.event({ event_type: "client", payload: {} }));
    server.write(rec.event({ event_type: "server", payload: {} }));
    client.write(rec.event({ event_type: "client-2", payload: {} }));
    expect(
      createFileReader(path)
        .read()
        .map((e) => e.event_type),
    ).toEqual(["client", "server", "client-2"]);
  });

  it("is fail-open: a write to an unwritable path reports and does not throw", () => {
    let reported: unknown;
    // A path whose parent directory does not exist cannot be opened.
    const writer = createFileWriter(
      join(dir, "missing", "run.ndjson"),
      (err) => {
        reported = err;
      },
    );
    expect(() =>
      writer.write(rec.event({ event_type: "a", payload: {} })),
    ).not.toThrow();
    expect(reported).toBeDefined();
  });
});

describe("listRunFiles", () => {
  it("lists every run oldest first, names being start timestamps", () => {
    for (const at of [300, 100, 200]) createRunWriter(dir, { now: () => at });
    expect(listRunFiles(dir)).toEqual([
      join(dir, "100.ndjson"),
      join(dir, "200.ndjson"),
      join(dir, "300.ndjson"),
    ]);
  });

  it("ignores non-run files in the directory", () => {
    writeFileSync(join(dir, "notes.txt"), "ignore me");
    createRunWriter(dir, { now: () => 1 });
    expect(listRunFiles(dir)).toEqual([join(dir, "1.ndjson")]);
  });

  it("reports no runs for a directory that does not exist", () => {
    expect(listRunFiles(join(dir, "nope"))).toEqual([]);
  });
});

describe("runIdFromPath", () => {
  it("reads the run id back out of the file name", () => {
    const writer = createRunWriter(dir, { now: () => 1721709600000 });
    expect(runIdFromPath(writer.path)).toBe("1721709600000");
  });
});

describe("readLatestRun", () => {
  it("selects the newest run by timestamped name", () => {
    createRunWriter(dir, { now: () => 100 }).write(
      rec.event({ event_type: "old", payload: {} }),
    );
    createRunWriter(dir, { now: () => 300 }).write(
      rec.event({ event_type: "new", payload: {} }),
    );
    createRunWriter(dir, { now: () => 200 }).write(
      rec.event({ event_type: "mid", payload: {} }),
    );
    const reader = readLatestRun(dir);
    expect(reader?.read().map((e) => e.event_type)).toEqual(["new"]);
  });

  it("returns null when there are no runs", () => {
    expect(readLatestRun(join(dir, "nope"))).toBeNull();
  });

  it("ignores non-run files in the directory", () => {
    writeFileSync(join(dir, "notes.txt"), "ignore me");
    createRunWriter(dir, { now: () => 1 }).write(
      rec.event({ event_type: "only", payload: {} }),
    );
    expect(
      readLatestRun(dir)
        ?.read()
        .map((e) => e.event_type),
    ).toEqual(["only"]);
  });
});
