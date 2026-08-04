/// <reference types="node" />
/**
 * The Node file-backed sink — the default persistence for TraceEvents, exposed at
 * the `@usehaia/trace-core/file` subpath.
 *
 * This is the ONLY module in core that imports `node:*`. Keeping it behind a
 * subpath is what lets the root export stay runtime-agnostic: a browser/edge
 * capture adapter imports the sink *contract* from the root and never drags
 * `node:fs` into its bundle, while Node consumers (the CLI, a Node recorder's
 * default sink) opt into the file implementation here.
 *
 * The store is `<dir>/<run_id>.ndjson`, one file per run, append-only. Writes use
 * append mode (`O_APPEND`), so several roles of one operation — a client and a
 * server in the same process — can append to the same run file without tearing
 * each other's lines.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import type { TraceEvent } from "../event.js";
import {
  decodeEventLines,
  type EventReader,
  type EventWriter,
  encodeEventLine,
  type SinkErrorHandler,
} from "./contract.js";

// Re-exported so the file sink's options read from one import; the type is
// declared with the sink contract because every sink implementation uses it.
export type { SinkErrorHandler } from "./contract.js";

/** Run files carry this extension; also how a directory listing tells them apart. */
const RUN_EXT = ".ndjson";

/**
 * Errno codes that put a path out of reach rather than report a machine
 * momentarily short of a resource: repeating the same write cannot clear them.
 *
 * Everything else is treated as transient and left to the next append —
 * `EMFILE`/`ENFILE` (the fd limit, which a busy process crosses and comes back
 * from), `ENOSPC` (a disk that may be freed), `EBUSY`, `EIO`. Erring toward
 * transient is the safe direction: mistaking a permanent failure for a passing
 * one costs a repeated error report, while the opposite costs the events.
 */
const UNRECOVERABLE_CODES = new Set([
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "EROFS",
  "ENAMETOOLONG",
  "ELOOP",
]);

/** Whether a filesystem error leaves the path permanently unwritable (see above). */
function isUnrecoverable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && UNRECOVERABLE_CODES.has(code);
}

/**
 * Hand a fault to the caller's handler, absorbing a handler that throws.
 *
 * `onError` is foreign code on the one path whose whole purpose is to *contain*
 * failure. A handler that rethrows — or a logger that throws on a non-`Error`
 * argument, and what it is given is `unknown` — must not turn a sink fault back
 * into an exception in the producer's payment path.
 */
function report(onError: SinkErrorHandler | undefined, err: unknown): void {
  try {
    onError?.(err);
  } catch {
    /* a handler's own failure has nowhere left to go */
  }
}

/**
 * Open a writer over an explicit file path. Used for a run file whose path is
 * already known, and for reading/writing fixtures in tests.
 *
 * Fail-open: an append error is routed to `onError` and swallowed, never thrown —
 * a producer in a payment path must not break because the disk did.
 *
 * Reported once when it is the *path* that failed. An error no later append can
 * clear — a deleted directory, a permission the process does not have — stops
 * the writer for good, because repeating it per event would bury the first
 * report, the only one that explains the run, under identical copies of itself.
 * A transient error is reported and the writer keeps going, since the next
 * append may be the one that works.
 */
export function createFileEventWriter(
  path: string,
  onError?: SinkErrorHandler,
): EventWriter {
  let stopped = false;
  return {
    write(event: TraceEvent): void {
      if (stopped) return;
      try {
        // `appendFileSync` opens with `O_APPEND` and closes per call, so writes
        // stay atomic per line and safe across processes sharing the run file.
        appendFileSync(path, `${encodeEventLine(event)}\n`);
      } catch (err) {
        stopped = isUnrecoverable(err);
        report(onError, err);
      }
    },
    close(): void {
      /* no persistent handle is held — nothing to release */
    },
  };
}

/** Options for a run writer, whose file name is stamped from the service's start time. */
export interface RunEventWriterOptions {
  /**
   * Epoch-millisecond clock for the file name; injectable so tests are
   * deterministic. Defaults to `Date.now`. Epoch ms is filesystem-safe (unlike an
   * ISO string, whose `:` is illegal on Windows) and sorts chronologically, so
   * "the latest run" is just the maximum file name.
   */
  now?: () => number;
  onError?: SinkErrorHandler;
}

/** A run writer, plus the resolved path of the file it created. */
export interface RunEventWriter extends EventWriter {
  /** Absolute-or-relative path of this run's file, e.g. `<dir>/1721709600000.ndjson`. */
  readonly path: string;
}

/**
 * Create the run file for a service start in `dir` and return a writer over it.
 * The name is the start timestamp, so each start (and each restart) gets its own
 * file — the run id is the file name, not a field repeated on every event.
 *
 * `dir` is required rather than defaulted: core describes events, it does not own
 * a directory layout, and a default here would be a filesystem convention two
 * packages had to keep agreeing on. The producer and whoever reads the runs back
 * must therefore be pointed at the same directory — `haia-trace` writes and reads
 * `.trace/events` unless its `--dir` says otherwise.
 *
 * The file is created eagerly, at construction: an empty run file records that
 * capture was attached and simply saw nothing, which must never read as "capture
 * failed" (the honesty invariant).
 *
 * Fail-open, and reported once: if the directory or the run file cannot be
 * created for a reason no later write can clear — a container whose working
 * directory the process may not write to is the usual cause — the error goes to
 * `onError` and the returned writer accepts events and drops them. An unusable
 * `dir` argument is the one exception, being a caller mistake rather than a disk
 * condition: it throws, as below.
 */
export function createRunEventWriter(
  dir: string,
  options: RunEventWriterOptions = {},
): RunEventWriter {
  // A caller mistake, not a disk condition, so it is *not* covered by the
  // fail-open policy below: there is no run file to fail open to without a
  // directory, and silently picking one is the agreeing-on-a-convention this
  // signature exists to refuse. Said in one line here because an untyped caller
  // gets no compile error — notably one carrying the older, argument-less form,
  // for whom the alternative is `ERR_INVALID_ARG_TYPE` from inside `node:path`.
  if (typeof dir !== "string" || dir.trim() === "") {
    throw new TypeError(
      'createRunEventWriter requires a run directory, e.g. createRunEventWriter(".trace/events")',
    );
  }

  const now = options.now ?? Date.now;
  const path = join(dir, `${now()}${RUN_EXT}`);

  try {
    mkdirSync(dir, { recursive: true });
    // Touch the file so an event-less run is still visible on disk.
    closeSync(openSync(path, "a"));
  } catch (err) {
    report(options.onError, err);
    // A run file that could not be created for a reason no later write can clear
    // makes every append a certainty to fail, with an `ENOENT` that says nothing
    // this first report did not. Hand back a writer that drops what it is given,
    // so one root cause stays one report rather than one per captured event —
    // noise that buries the error actually explaining the run.
    //
    // Only for that class of failure. A touch that lost a race for a file
    // descriptor, or met a disk that is later freed, falls through to the
    // ordinary writer instead: `appendFileSync` creates the file itself, so such
    // a run still records everything from the moment the condition clears.
    if (isUnrecoverable(err)) {
      return {
        path,
        write(): void {
          /* nowhere to append; the reason went to `onError` at construction */
        },
        close(): void {
          /* nothing was opened */
        },
      };
    }
  }

  const writer = createFileEventWriter(path, options.onError);
  return {
    path,
    write: writer.write,
    close: writer.close,
  };
}

/** Open a reader over an explicit run (or fixture) file. Tolerant of a torn tail; see `decodeEventLines`. */
export function createFileEventReader(path: string): EventReader {
  return {
    read(): TraceEvent[] {
      return decodeEventLines(readFileSync(path, "utf8"));
    },
  };
}

/**
 * The run id of a run file — its name without the extension. The id is the file
 * name rather than a field on every event, so this is the one place that
 * convention is turned back into an id.
 */
export function runIdFromPath(path: string): string {
  return basename(path, RUN_EXT);
}

/**
 * Every run in `dir`, as paths, oldest first — names being start timestamps,
 * sorting by name sorts by time. An unreadable directory yields no runs rather
 * than an error: no directory yet simply means nothing has been recorded.
 *
 * Deliberately a *list*, not a reader over the concatenation of all runs. Events
 * carry no run id, and `context_id` is only unique within a run — an adapter is
 * free to number operations per session — so concatenating two runs and grouping
 * by `context_id` would fold unrelated operations into one receipt. A consumer
 * that wants several runs assembles each one separately.
 */
export function listRunFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(RUN_EXT))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * A reader over the most recent run in `dir` — the newest run file by name, which
 * (names being start timestamps) is the newest by time. Returns `null` when the
 * directory has no run files. Backs "show the last operation" without an index.
 */
export function readLatestRun(dir: string): EventReader | null {
  const runs = listRunFiles(dir);
  const latest = runs[runs.length - 1];
  if (latest === undefined) return null;
  return createFileEventReader(latest);
}
