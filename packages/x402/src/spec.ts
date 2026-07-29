/**
 * The capture contract: one spec per x402 instance kind — which hooks it
 * exposes, what each firing becomes, and which side observed it.
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
 * Where a wrapper kind keeps the instance owning the rest of its hooks:
 * `x402HTTPClient` exposes only `onPaymentRequired` and `x402HTTPResourceServer`
 * only `onProtectedRequest`, so attaching to the wrapper alone would register
 * one hook and still look connected.
 */
export interface InnerInstance {
  /** Candidate property names, tried in order. */
  props: readonly string[];
  /** The kind whose hooks that instance owns. */
  kind: TraceInstanceKind;
}

interface SpecIdentity {
  kind: TraceInstanceKind;
  role: TraceRole;
  inner?: InnerInstance;
}

/**
 * Everything `trace()` needs about one kind. The runtime hook list is
 * `Object.keys(mappers)`, so a hook without a mapper — or a mapper for a hook
 * the kind lacks — is a compile error, and each mapper's context stays exact:
 * the server and the facilitator share six hook *names* but not their types.
 */
export interface CaptureSpec<Hooks> extends SpecIdentity {
  mappers: HookMappers<Hooks>;
}

/**
 * A spec with its hook contexts erased, so every kind's sits in one registry.
 * `never` is what makes the erasure sound: any concrete mapper is assignable to
 * it, and calling one takes the deliberate widening `attach.ts` does once.
 */
export interface ErasedSpec extends SpecIdentity {
  mappers: Readonly<Record<string, (context: never) => HookEvent>>;
}

/** Type-check a kind's mappers against its hook interface, then erase them. */
export function defineCapture<Hooks>(spec: CaptureSpec<Hooks>): ErasedSpec {
  return spec as ErasedSpec;
}
