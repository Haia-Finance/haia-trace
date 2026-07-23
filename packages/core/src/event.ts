/**
 * The Event Contract — the normalized shape every capture adapter emits and the
 * receipt assembler consumes. Events are written append-only as NDJSON and read
 * back by tools in other languages, so field names are snake_case and values are
 * plain JSON.
 *
 * The contract is protocol-agnostic: it defines the generic envelope, while the
 * vocabulary of `event_type` and `role` belongs to the adapter that produces the
 * events (an x402 recorder, an MPP recorder, …).
 *
 * One recorder session is one sink file, `.trace/events/<run_id>.ndjson`; the
 * run id is the file name rather than a field repeated on every event.
 */

/**
 * Namespaced event name, by convention `<domain>.<subject>.<outcome>` — e.g.
 * `x402.payment.required`, `chain.transfer.confirmed`. An open string: the set
 * of event types is defined by adapters and templates, not enumerated here.
 */
export type EventType = string;

/**
 * The part an instance played, as named by its adapter — e.g. `client`,
 * `server`, `facilitator`. Separate from `event_type` because one event (such as
 * `x402.settle.ok`) can be observed from more than one side.
 */
export type Role = string;

/** One normalized observation of a payment operation — the unit the assembler reads. */
export interface TraceEvent {
  /** Any collision-resistant unique id; `crypto.randomUUID()` is the default. Ordering is by `seq`, not this. */
  event_id: string;
  /** Namespaced event name; templates match on this. */
  event_type: EventType;
  /** When the fact occurred — ISO-8601 UTC, millisecond precision. */
  occurred_at: string;
  /**
   * Groups the events of one logical operation, telling apart concurrent
   * requests that are otherwise identical. Set by the adapter from the runtime's
   * async context; absent when there is no request context (e.g. a chain
   * confirmation or an attestation event).
   */
  context_id?: string;
  /** Order of capture within the session; monotonic, so same-timestamp events still sort deterministically. */
  seq: number;
  /** Id of the adapter that produced the event, e.g. `trace-x402`. */
  adapter: string;
  /** The side that observed the event, when the source has one. */
  role?: Role;
  /** Normalized, redacted event fields. Allowlisted — never signatures, keys, credentials, or raw captured context. */
  payload: Record<string, unknown>;
}
