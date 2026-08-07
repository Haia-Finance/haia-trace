/**
 * The event sink contract — how TraceEvents are persisted and read back, kept
 * behind an interface so the backing store is swappable (a local NDJSON file, an
 * in-memory buffer for tests, a platform upload later) without any producer or
 * the assembler knowing which one it holds.
 *
 * This module is deliberately pure and runtime-agnostic — the interfaces plus the
 * string codec, no filesystem. It is part of the root `@usehaia/trace-core`
 * export, so every capture adapter (in any runtime, including the browser) can
 * depend on the sink contract. The concrete file-backed implementation lives
 * behind the `@usehaia/trace-core/file` subpath, which is the only place
 * `node:fs` is imported.
 *
 * On-disk format is NDJSON (newline-delimited JSON): one TraceEvent per line,
 * append-only. It is line-addressable (an append is one line), human-readable,
 * and reads back with the same codec fixtures and real captures share — so a
 * sample run flows through the identical path as a live one.
 */

import type { TraceEvent } from "../event.js";

/**
 * Observe a sink failure (a full disk, a refused upload) without it ever
 * reaching the producer. Every sink implementation routes its faults here
 * rather than throwing, which is what makes the fail-open guarantee below hold.
 */
export type SinkErrorHandler = (err: unknown) => void;

/**
 * Serialize one event to a single NDJSON line (no trailing newline — the writer
 * adds the separator). Plain `JSON.stringify`, so encoding is deterministic for a
 * given event: the receipt-integrity guarantee starts here.
 */
export function encodeEventLine(event: TraceEvent): string {
  return JSON.stringify(event);
}

/** Parse one NDJSON line into a TraceEvent. Throws on malformed JSON. */
export function decodeEventLine(line: string): TraceEvent {
  return JSON.parse(line) as TraceEvent;
}

/**
 * Parse a whole NDJSON document into events.
 *
 * Tolerant of a torn tail — the load-bearing detail for append-only capture. A
 * complete append always ends the record with `\n`, so the text after the final
 * newline is never a complete record: it is either empty (a clean file) or a
 * half-written line (a reader racing a concurrent writer). Either way the final
 * segment is dropped rather than trusted.
 *
 * A parse failure on any *earlier* line is real corruption, not a race, and
 * throws with the line number rather than silently vanishing — "no events" must
 * never be forged from a broken file (the honesty invariant).
 */
export function decodeEventLines(text: string): TraceEvent[] {
  const segments = text.split("\n");
  // The last segment is never a complete record: "" for a clean file, or a torn
  // partial line for a file caught mid-append. Drop it either way.
  segments.pop();

  const events: TraceEvent[] = [];
  segments.forEach((segment, i) => {
    // Append never emits blank lines, so a blank one is a manual edit, not data —
    // skip defensively rather than fail the whole read.
    if (segment.trim() === "") return;
    try {
      events.push(decodeEventLine(segment));
    } catch (err) {
      throw new Error(
        `malformed event on line ${i + 1}: ${(err as Error).message}`,
      );
    }
  });
  return events;
}

/**
 * Where a producer sends events. One writer is bound to one sink (for the file
 * implementation, one run file). `write` must not throw into the caller: a
 * producer may sit in a payment path, and a sink failure has to degrade to
 * "capture stopped", never "payment broke" (a fail-open guarantee).
 *
 * `write` RETURNS whether the sink accepted the event, so a caller with real
 * delivery semantics — a webhook receiver that must answer 500 for the source
 * to redeliver — can act on a failure without the writer ever throwing. A
 * caller with no such semantics ignores the return and keeps the fail-open
 * behavior unchanged; the fault still reaches the writer's error handler
 * either way, so acting on `false` is opt-in, never required.
 */
export interface EventWriter {
  /**
   * Append one event. Never throws; a backing-store failure is routed to the
   * writer's error handler. Returns `true` when the sink accepted the event —
   * persisted it, for a sink that stores inside `write`; took it into the
   * buffer, for one that delivers later (whose delivery faults go to the error
   * handler, not this return) — and `false` when it was refused or dropped.
   */
  write(event: TraceEvent): boolean;
  /**
   * Settle everything `write` has accepted so far, for a writer that does not
   * hand the event to its store synchronously.
   *
   * Optional because a writer that persists inside `write` — the file sink —
   * has nothing to settle. A writer that buffers (one that batches events into
   * network requests) implements it, and a caller that needs "the events are
   * delivered, not merely accepted" — a process about to exit — awaits it
   * before `close`. Like `write`, it never rejects: a delivery failure is
   * routed to the writer's error handler, not thrown at the caller.
   */
  flush?(): Promise<void>;
  /** Release any held resource. Safe to call more than once. */
  close(): void;
}

/** Where the assembler (or a renderer) reads a run's events from. */
export interface EventReader {
  /** All events of the run, in capture order (which is `seq` order within a run). */
  read(): TraceEvent[];
}
