/**
 * `@usehaia/trace-x402` — a strictly passive recorder over the x402 v2 lifecycle
 * hooks. Every handler it registers is wrapped in try/catch and always returns
 * `undefined`, so it can observe a payment but never steer one: x402 hooks read
 * their return value as a command (`{ abort }`, `{ skip }`, …).
 *
 * Hooks reference: https://docs.x402.org/advanced-concepts/lifecycle-hooks
 *
 * This module is the package's export surface and nothing else — what is not
 * re-exported here is internal, however it is spelled inside `src/`.
 */

export type { TraceAttestation } from "./capture/attach.js";
export { resetTraceSession } from "./capture/session.js";
export type {
  TraceInstanceKind,
  TraceKind,
  TraceRole,
} from "./capture/spec.js";
export { type TraceOptions, trace } from "./capture/trace.js";
