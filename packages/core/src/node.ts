/// <reference types="node" />
/**
 * The Node file-backed sink — the default persistence for TraceEvents, exposed at
 * the `@usehaia/trace-core/node` subpath.
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
import { join } from "node:path";

import type { TraceEvent } from "./event.js";
import {
  decodeEventLines,
  type EventReader,
  type EventWriter,
  encodeEventLine,
} from "./sink.js";

/** Run files carry this extension; also how a directory listing tells them apart. */
const RUN_EXT = ".ndjson";

/** Observe a sink error (disk full, permissions) without it ever reaching the producer. */
export type SinkErrorHandler = (err: unknown) => void;

/**
 * Open a writer over an explicit file path. Used for a run file whose path is
 * already known, and for reading/writing fixtures in tests.
 *
 * Fail-open: an append error is routed to `onError` and swallowed, never thrown —
 * a producer in a payment path must not break because the disk did.
 */
export function createFileWriter(
  path: string,
  onError?: SinkErrorHandler,
): EventWriter {
  return {
    write(event: TraceEvent): void {
      try {
        // `appendFileSync` opens with `O_APPEND` and closes per call, so writes
        // stay atomic per line and safe across processes sharing the run file.
        appendFileSync(path, `${encodeEventLine(event)}\n`);
      } catch (err) {
        onError?.(err);
      }
    },
    close(): void {
      /* no persistent handle is held — nothing to release */
    },
  };
}

/** Options for a run writer, whose file name is stamped from the service's start time. */
export interface RunWriterOptions {
  /** Directory the run file is created in, e.g. `.trace/events`. Created if absent. */
  dir: string;
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
export interface RunWriter extends EventWriter {
  /** Absolute-or-relative path of this run's file, e.g. `.trace/events/1721709600000.ndjson`. */
  readonly path: string;
}

/**
 * Create the run file for a service start and return a writer over it. The name
 * is the start timestamp, so each start (and each restart) gets its own file —
 * the run id is the file name, not a field repeated on every event.
 *
 * The file is created eagerly, at construction: an empty run file records that
 * capture was attached and simply saw nothing, which must never read as "capture
 * failed" (the honesty invariant).
 */
export function createRunWriter(options: RunWriterOptions): RunWriter {
  const now = options.now ?? Date.now;
  const path = join(options.dir, `${now()}${RUN_EXT}`);

  try {
    mkdirSync(options.dir, { recursive: true });
    // Touch the file so an event-less run is still visible on disk.
    closeSync(openSync(path, "a"));
  } catch (err) {
    options.onError?.(err);
  }

  const writer = createFileWriter(path, options.onError);
  return {
    path,
    write: writer.write,
    close: writer.close,
  };
}

/** Open a reader over an explicit run (or fixture) file. Tolerant of a torn tail; see `decodeEventLines`. */
export function createFileReader(path: string): EventReader {
  return {
    read(): TraceEvent[] {
      return decodeEventLines(readFileSync(path, "utf8"));
    },
  };
}

/**
 * A reader over the most recent run in `dir` — the newest run file by name, which
 * (names being start timestamps) is the newest by time. Returns `null` when the
 * directory has no run files. Backs "show the last operation" without an index.
 */
export function readLatestRun(dir: string): EventReader | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // No directory yet means no runs, not an error to surface here.
    return null;
  }
  const runs = entries.filter((name) => name.endsWith(RUN_EXT)).sort();
  const latest = runs[runs.length - 1];
  if (latest === undefined) return null;
  return createFileReader(join(dir, latest));
}
