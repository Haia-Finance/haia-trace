/**
 * `@usehaia/trace-x402` — passive recorder over the x402 v2 lifecycle hooks.
 * Hooks reference: https://docs.x402.org/advanced-concepts/lifecycle-hooks
 *
 * `trace(instance)` resolves the instance's kind (client, resource server,
 * facilitator, …) by duck-typing (`registry.ts`), attaches to that kind's
 * lifecycle hooks — including the ones on the instance a wrapper kind holds
 * (`attach.ts`) — and turns every firing into an Event Contract `TraceEvent`: an
 * allowlisted payload (each role's capture module over `normalize.ts`), the
 * observing `role` fixed by the kind, and the `context_id` that groups one
 * request's events (`correlate.ts`). Events are stamped by a
 * `@usehaia/trace-core` recorder and handed to an `EventWriter` (`session.ts`).
 *
 * Strictly passive — the load-bearing invariant. x402 lifecycle hooks can steer
 * the payment flow through their return value (`{ abort }`, `{ skip }`,
 * `{ recovered }`, …). Every handler registered is wrapped in try/catch and
 * ALWAYS returns `undefined`, so the recorder can observe a payment but never
 * alter it.
 *
 * This module is the package's export surface and nothing else — what is not
 * re-exported here is internal, however it is spelled inside `src/`.
 */

export type { TraceAttestation } from "./attach.js";
export { resetTraceSession } from "./session.js";
export type { TraceInstanceKind, TraceKind, TraceRole } from "./spec.js";
export { type TraceOptions, trace } from "./trace.js";
