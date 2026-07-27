/// <reference types="node" />
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileReader,
  createFileWriter,
  createRunWriter,
  DEFAULT_RUN_DIR,
  readLatestRun,
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
    const writer = createRunWriter({ dir, now: () => 1721709600000 });
    expect(writer.path).toBe(join(dir, "1721709600000.ndjson"));
    // The file *name* must be filesystem-safe on every OS — notably no ':' (which
    // an ISO timestamp would carry, and which Windows forbids). Check the basename,
    // not the full path, since the temp dir itself contains a drive-letter colon.
    expect(basename(writer.path)).not.toContain(":");
  });

  it("creates the file eagerly, so an event-less run is still visible", () => {
    const writer = createRunWriter({ dir, now: () => 1 });
    expect(readFileSync(writer.path, "utf8")).toBe("");
  });

  it("defaults to the run directory the CLI reads, so no path has to be agreed", () => {
    // A producer that configures nothing must land where `haia-trace build`
    // looks; run it in a temp cwd so the assertion is about the default, not
    // about this repository's working directory.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const writer = createRunWriter({ now: () => 1 });
      expect(writer.path).toBe(join(DEFAULT_RUN_DIR, "1.ndjson"));
      expect(readFileSync(writer.path, "utf8")).toBe("");
      // And the reader finds it without being told where either.
      expect(readLatestRun(DEFAULT_RUN_DIR)).not.toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });

  it("round-trips events through the file", () => {
    const writer = createRunWriter({ dir, now: () => 1 });
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

describe("readLatestRun", () => {
  it("selects the newest run by timestamped name", () => {
    createRunWriter({ dir, now: () => 100 }).write(
      rec.event({ event_type: "old", payload: {} }),
    );
    createRunWriter({ dir, now: () => 300 }).write(
      rec.event({ event_type: "new", payload: {} }),
    );
    createRunWriter({ dir, now: () => 200 }).write(
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
    createRunWriter({ dir, now: () => 1 }).write(
      rec.event({ event_type: "only", payload: {} }),
    );
    expect(
      readLatestRun(dir)
        ?.read()
        .map((e) => e.event_type),
    ).toEqual(["only"]);
  });
});
