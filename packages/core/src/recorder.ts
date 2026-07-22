/**
 * The recorder factory — the one place a capture adapter mints TraceEvents.
 *
 * It owns the session's `seq` counter so the monotonic-ordering guarantee lives
 * in a single spot rather than being re-implemented (and mis-implemented) at
 * every call site. The adapter supplies only the meaningful fields; the recorder
 * stamps `event_id`, `occurred_at`, `seq`, and `adapter`.
 *
 * `context_id` is deliberately not generated here. It groups the events of one
 * logical operation, so its value comes from the adapter's runtime context (an
 * async-context store, or a protocol request id) — a per-event id would defeat
 * the grouping. The adapter passes it in when it has one.
 */

import type { EventType, Role, TraceEvent } from "./event.js";

/**
 * The Web Crypto `randomUUID`, a global in Node >= 20, browsers, and edge
 * runtimes. Read off `globalThis` with a local type so core needs neither
 * `lib: ["DOM"]` nor `@types/node` — keeping it runtime-agnostic and dependency-free.
 */
function randomUUID(): string {
  return (
    globalThis as unknown as { crypto: { randomUUID: () => string } }
  ).crypto.randomUUID();
}

/** The per-event fields an adapter provides; the recorder stamps the rest. */
export interface EventInput {
  /** Namespaced event name; templates match on this. */
  event_type: EventType;
  /** Normalized, redacted event fields. Never signatures, keys, or credentials. */
  payload: Record<string, unknown>;
  /** The side that observed the event, when the source has one. */
  role?: Role;
  /** Operation-grouping id, when the adapter has one from its runtime context. */
  context_id?: string;
}

export interface EventRecorder {
  /** Stamp a full TraceEvent from the adapter-supplied fields, advancing `seq`. */
  event(input: EventInput): TraceEvent;
}

export interface RecorderOptions {
  /** Id of the adapter that produced the events, e.g. `trace-x402`. */
  adapter: string;
  /**
   * Wall clock, returning an ISO-8601 UTC timestamp. Injectable so assembler and
   * golden-file tests stay deterministic; defaults to `new Date().toISOString()`.
   */
  now?: () => string;
  /**
   * Event-id source. Injectable for the same reason; defaults to
   * `crypto.randomUUID()` (uuidv4) — dependency-free and unique, which is all
   * `event_id` needs since ordering is by `seq`.
   */
  newId?: () => string;
}

/**
 * Create a recorder bound to one session (one sink file). Each `event()` call
 * returns the next TraceEvent with a fresh `event_id`/`occurred_at` and the next
 * `seq`, starting from 0.
 */
export function createRecorder(options: RecorderOptions): EventRecorder {
  const { adapter } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? randomUUID;

  let seq = 0;

  return {
    event(input: EventInput): TraceEvent {
      return {
        event_id: newId(),
        event_type: input.event_type,
        occurred_at: now(),
        ...(input.context_id !== undefined
          ? { context_id: input.context_id }
          : {}),
        seq: seq++,
        adapter,
        ...(input.role !== undefined ? { role: input.role } : {}),
        // Shallow-copy so a caller that reuses and mutates one payload object
        // across fires can't rewrite an already-recorded event's top-level fields.
        payload: { ...input.payload },
      };
    },
  };
}
