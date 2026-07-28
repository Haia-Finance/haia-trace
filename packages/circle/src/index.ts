/**
 * `@usehaia/trace-circle` — Haia Trace capture adapter for Circle webhook v2
 * notifications (Wallets transactions, Contracts event logs).
 *
 * Unlike the in-process x402 adapter, this source is EXTERNAL: Circle POSTs
 * signed notifications to an HTTPS endpoint, at-least-once and unordered. That
 * physics dictates the pipeline this package provides the pieces of:
 *
 *   verify    — ECDSA signature over the raw body; not-Circle input is dropped
 *   envelope  — validate the v2 envelope loudly before trusting any field
 *   dedupe    — at-least-once delivery → exactly-once in the event sink
 *
 * The package hosts no HTTP server — the pieces embed into whatever server
 * receives the POSTs (a Next.js route, a CLI listener), which keeps the
 * package framework-agnostic and free of third-party runtime dependencies.
 *
 * One deliberate departure from the x402 adapter's fail-open discipline: for a
 * webhook source, swallowing a persistence error and answering 200 would stop
 * Circle's retries and lose the event forever. The pieces therefore report
 * their outcome to the caller (invalid signature → reject the request, sink
 * failure → let Circle retry) instead of failing silently.
 *
 * Normalization into `TraceEvent`s is the next layer on top of these pieces
 * and lands separately, together with the operation template it feeds.
 */

export {
  createMemoryDedupeStore,
  type DedupeStore,
  type MemoryDedupeOptions,
} from "./dedupe.js";
export {
  assertNotificationEnvelope,
  type NotificationEnvelope,
  parseNotificationEnvelope,
} from "./envelope.js";

export {
  createVerifier,
  type NotificationVerifier,
  type PublicKeyResolver,
  type VerifierOptions,
} from "./verify.js";
