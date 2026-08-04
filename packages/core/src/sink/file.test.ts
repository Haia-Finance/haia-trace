/// <reference types="node" />
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecorder } from "../recorder.js";
import {
  createFileEventReader,
  createFileEventWriter,
  createRunEventWriter,
  listRunFiles,
  readLatestRun,
  runIdFromPath,
} from "./file.js";

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

describe("createRunEventWriter", () => {
  it("names the file with the start timestamp and no illegal characters", () => {
    const writer = createRunEventWriter(dir, { now: () => 1721709600000 });
    expect(writer.path).toBe(join(dir, "1721709600000.ndjson"));
    // The file *name* must be filesystem-safe on every OS — notably no ':' (which
    // an ISO timestamp would carry, and which Windows forbids). Check the basename,
    // not the full path, since the temp dir itself contains a drive-letter colon.
    expect(basename(writer.path)).not.toContain(":");
  });

  it("creates the file eagerly, so an event-less run is still visible", () => {
    const writer = createRunEventWriter(dir, { now: () => 1 });
    expect(readFileSync(writer.path, "utf8")).toBe("");
  });

  it("refuses a missing or empty directory with a message that names the fix", () => {
    // The fail-open policy covers the disk, not the caller: without a directory
    // there is no run file to fail open to. An untyped caller gets no compile
    // error, so the message has to carry the migration from the older form.
    for (const bad of [undefined, null, "", "   "]) {
      expect(() =>
        createRunEventWriter(bad as unknown as string, { now: () => 1 }),
      ).toThrow(/createRunEventWriter requires a run directory/);
    }
    // And it is the argument that is rejected, not the disk — `onError` is for
    // I/O and must not be handed a caller mistake it cannot act on.
    const reported: unknown[] = [];
    expect(() =>
      createRunEventWriter("", { onError: (err) => reported.push(err) }),
    ).toThrow(TypeError);
    expect(reported).toEqual([]);
  });

  it("creates the run directory when it does not exist yet", () => {
    // A producer names a directory, not a directory that already exists — the
    // first run of a fresh checkout must not have to mkdir first.
    const nested = join(dir, "deep", "events");
    const writer = createRunEventWriter(nested, { now: () => 1 });
    expect(writer.path).toBe(join(nested, "1.ndjson"));
    expect(readFileSync(writer.path, "utf8")).toBe("");
  });

  it("reports a directory it cannot create once, not once per event", () => {
    // A directory *under a regular file* can never be created, which is the
    // portable stand-in for the real cause: a working directory the process is
    // not allowed to write to. The run file is therefore never created, so
    // every append would fail with the same ENOENT — a cascade that buries the
    // one error explaining the run. The writer stays fail-open and quiet.
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "");
    const reported: unknown[] = [];
    const writer = createRunEventWriter(join(blocker, "events"), {
      now: () => 1,
      onError: (err) => reported.push(err),
    });
    expect(reported).toHaveLength(1);

    expect(() => {
      writer.write(rec.event({ event_type: "a", payload: {} }));
      writer.write(rec.event({ event_type: "b", payload: {} }));
      writer.close();
    }).not.toThrow();
    expect(reported).toHaveLength(1);

    // What is reported is the filesystem's own diagnosis — the one thing that
    // tells an operator why the run is missing — and not a synthesized stand-in
    // that would leave them nothing to act on. Nothing reached the disk either.
    expect((reported[0] as NodeJS.ErrnoException).code).toBe("ENOTDIR");
    expect(listRunFiles(dir)).toEqual([]);

    // The path is still the run file it set out to create, so a caller that
    // derives the run id from it (a second sink mirroring the same run) is
    // unaffected by the local failure.
    expect(runIdFromPath(writer.path)).toBe("1");
  });

  it("fails open the same way when only the run file cannot be created", () => {
    // Here the directory is fine and it is the *file* that cannot be created,
    // because a directory already occupies its name. This is the half of the
    // creation step an existing-but-unwritable `.trace/events` reaches, and it
    // has to behave exactly like the directory half.
    mkdirSync(join(dir, "1.ndjson"));
    const reported: unknown[] = [];
    const writer = createRunEventWriter(dir, {
      now: () => 1,
      onError: (err) => reported.push(err),
    });
    expect(reported).toHaveLength(1);
    expect(() =>
      writer.write(rec.event({ event_type: "a", payload: {} })),
    ).not.toThrow();
    expect(reported).toHaveLength(1);
  });

  it("keeps recording when the failure is one that may still clear", async () => {
    // The fd limit is the realistic case: a busy process crosses it for a moment
    // and comes back from it. Simulated, since exhausting descriptors for real
    // is a slow and machine-dependent way to make the same point. `appendFileSync`
    // creates the file itself, so the run records everything from the moment the
    // condition clears — a writer that latched here would have dropped all of it.
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = (await vi.importActual(
        "node:fs",
      )) as typeof import("node:fs");
      let firstOpen = true;
      return {
        ...actual,
        openSync(...args: Parameters<typeof actual.openSync>) {
          if (!firstOpen) return actual.openSync(...args);
          firstOpen = false;
          throw Object.assign(new Error("EMFILE: too many open files"), {
            code: "EMFILE",
          });
        },
      };
    });
    try {
      const fs = await import("./file.js");
      const reported: unknown[] = [];
      const writer = fs.createRunEventWriter(dir, {
        now: () => 1,
        onError: (err) => reported.push(err),
      });
      expect(reported).toHaveLength(1);
      writer.write(rec.event({ event_type: "recovered", payload: {} }));
      expect(
        createFileEventReader(writer.path)
          .read()
          .map((e) => e.event_type),
      ).toEqual(["recovered"]);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("absorbs an onError that throws at construction", () => {
    // `onError` is the caller's code on the one path whose purpose is to contain
    // failure. A handler that rethrows — treating capture failure as fatal, say
    // — must not take the producer down with it at startup.
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "");
    expect(() =>
      createRunEventWriter(join(blocker, "events"), {
        now: () => 1,
        onError: () => {
          throw new Error("handler exploded");
        },
      }),
    ).not.toThrow();
  });

  it("round-trips events through the file", () => {
    const writer = createRunEventWriter(dir, { now: () => 1 });
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
    expect(createFileEventReader(writer.path).read()).toEqual([a, b]);
  });
});

describe("createFileEventWriter", () => {
  it("appends across two writers sharing one run file", () => {
    const path = join(dir, "shared.ndjson");
    const client = createFileEventWriter(path);
    const server = createFileEventWriter(path);
    client.write(rec.event({ event_type: "client", payload: {} }));
    server.write(rec.event({ event_type: "server", payload: {} }));
    client.write(rec.event({ event_type: "client-2", payload: {} }));
    expect(
      createFileEventReader(path)
        .read()
        .map((e) => e.event_type),
    ).toEqual(["client", "server", "client-2"]);
  });

  it("is fail-open: a write to an unwritable path reports and does not throw", () => {
    let reported: unknown;
    // A path whose parent directory does not exist cannot be opened.
    const writer = createFileEventWriter(
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

  it("reports a path that can never be written once, not once per event", () => {
    // The same cascade the run writer avoids, reached through the path-level
    // writer: nothing here creates the missing parent directory, so every append
    // would fail identically and bury the first report under copies of itself.
    const reported: unknown[] = [];
    const writer = createFileEventWriter(
      join(dir, "missing", "run.ndjson"),
      (err) => reported.push(err),
    );
    for (const event_type of ["a", "b", "c"]) {
      writer.write(rec.event({ event_type, payload: {} }));
    }
    expect(reported).toHaveLength(1);
    expect((reported[0] as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("absorbs an onError that throws on write", () => {
    const writer = createFileEventWriter(
      join(dir, "missing", "run.ndjson"),
      () => {
        throw new Error("handler exploded");
      },
    );
    expect(() =>
      writer.write(rec.event({ event_type: "a", payload: {} })),
    ).not.toThrow();
  });
});

describe("listRunFiles", () => {
  it("lists every run oldest first, names being start timestamps", () => {
    for (const at of [300, 100, 200])
      createRunEventWriter(dir, { now: () => at });
    expect(listRunFiles(dir)).toEqual([
      join(dir, "100.ndjson"),
      join(dir, "200.ndjson"),
      join(dir, "300.ndjson"),
    ]);
  });

  it("ignores non-run files in the directory", () => {
    writeFileSync(join(dir, "notes.txt"), "ignore me");
    createRunEventWriter(dir, { now: () => 1 });
    expect(listRunFiles(dir)).toEqual([join(dir, "1.ndjson")]);
  });

  it("reports no runs for a directory that does not exist", () => {
    expect(listRunFiles(join(dir, "nope"))).toEqual([]);
  });
});

describe("runIdFromPath", () => {
  it("reads the run id back out of the file name", () => {
    const writer = createRunEventWriter(dir, { now: () => 1721709600000 });
    expect(runIdFromPath(writer.path)).toBe("1721709600000");
  });
});

describe("readLatestRun", () => {
  it("selects the newest run by timestamped name", () => {
    createRunEventWriter(dir, { now: () => 100 }).write(
      rec.event({ event_type: "old", payload: {} }),
    );
    createRunEventWriter(dir, { now: () => 300 }).write(
      rec.event({ event_type: "new", payload: {} }),
    );
    createRunEventWriter(dir, { now: () => 200 }).write(
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
    createRunEventWriter(dir, { now: () => 1 }).write(
      rec.event({ event_type: "only", payload: {} }),
    );
    expect(
      readLatestRun(dir)
        ?.read()
        .map((e) => e.event_type),
    ).toEqual(["only"]);
  });
});
