/**
 * The capture contract every role implements: which hooks one kind of x402
 * instance exposes, what each firing becomes, and which side observed it.
 *
 * One spec per kind is the single source of truth. The runtime hook list is
 * `Object.keys(spec.mappers)`, so a hook without a mapper — or a mapper for a
 * hook the kind does not have — cannot be written down. That also keeps each
 * mapper's context exact: the server and the facilitator share six hook *names*
 * but not their context types, and a spec per kind never has to union them.
 */

import type { EventType } from "@usehaia/trace-core";

import type { CorrelationKeys } from "./correlate.js";

/** The x402 instance kinds `trace()` recognizes. */
export type TraceInstanceKind =
  | "client"
  | "httpClient"
  | "mcpClient"
  | "resourceServer"
  | "httpResourceServer"
  | "facilitator";

/** A recognized kind, or `"unknown"` when inference can't place the instance. */
export type TraceKind = TraceInstanceKind | "unknown";

/** The observing side of a payment, stamped on every recorded event. */
export type TraceRole = "client" | "server" | "facilitator" | "unknown";

/** One hook firing, reduced to what gets recorded and how it is grouped. */
export interface HookEvent extends CorrelationKeys {
  event_type: EventType;
  payload: Record<string, unknown>;
}

/** One mapper per hook of a kind: the context the SDK hands it in, one event out. */
export type HookMappers<Hooks> = {
  [K in keyof Hooks]: (context: Hooks[K]) => HookEvent;
};

/**
 * Where a wrapper kind keeps the instance that owns the rest of its hooks.
 *
 * The two HTTP types are wrappers: `x402HTTPClient` exposes only
 * `onPaymentRequired` and `x402HTTPResourceServer` only `onProtectedRequest`,
 * while the payment-creation and verify/settle hooks live on the `x402Client` /
 * `x402ResourceServer` each holds. Attaching to the wrapper alone would register
 * one hook of the kind's group and still look like a connected recorder.
 */
export interface InnerInstance {
  /** Candidate property names, tried in order. */
  props: readonly string[];
  /** The kind whose hooks that instance owns. */
  kind: TraceInstanceKind;
}

/** Everything `trace()` needs to know about one kind of x402 instance. */
export interface CaptureSpec<Hooks> {
  kind: TraceInstanceKind;
  role: TraceRole;
  mappers: HookMappers<Hooks>;
  inner?: InnerInstance;
}

/**
 * A spec with its hook contexts erased, so specs of every kind sit in one
 * registry. `never` as the parameter is what makes the erasure sound: any
 * concrete mapper is assignable to it, and calling one requires the deliberate
 * widening the attach layer does in a single place.
 */
export interface ErasedSpec {
  kind: TraceInstanceKind;
  role: TraceRole;
  mappers: Readonly<Record<string, (context: never) => HookEvent>>;
  inner?: InnerInstance;
}

/**
 * Declare a kind's capture: type-checks the mappers against the kind's hook
 * interface — every hook mapped, nothing extra — then erases them for the registry.
 */
export function defineCapture<Hooks>(spec: CaptureSpec<Hooks>): ErasedSpec {
  return spec as ErasedSpec;
}
