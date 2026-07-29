/**
 * Every recognized kind's capture spec, and how an untyped instance is placed
 * into one. Detection is pure duck-typing — no `@x402` value is imported at
 * runtime — so forks are covered and an unrecognized shape degrades to
 * `"unknown"` rather than failing.
 */

import {
  CLIENT_SPEC,
  HTTP_CLIENT_SPEC,
  MCP_CLIENT_SPEC,
} from "./roles/client/capture.js";
import { FACILITATOR_SPEC } from "./roles/facilitator/capture.js";
import {
  HTTP_RESOURCE_SERVER_SPEC,
  RESOURCE_SERVER_SPEC,
} from "./roles/server/capture.js";
import type { ErasedSpec, TraceInstanceKind, TraceKind } from "./spec.js";

export const SPECS: Record<TraceInstanceKind, ErasedSpec> = {
  client: CLIENT_SPEC,
  httpClient: HTTP_CLIENT_SPEC,
  mcpClient: MCP_CLIENT_SPEC,
  resourceServer: RESOURCE_SERVER_SPEC,
  httpResourceServer: HTTP_RESOURCE_SERVER_SPEC,
  facilitator: FACILITATOR_SPEC,
};

/** The hook names a kind exposes, in the order they are registered. */
export const hooksOf = (kind: TraceInstanceKind): string[] =>
  Object.keys(SPECS[kind].mappers);

// A Set, not an `in` check, so a prototype key such as "constructor" can't slip
// through into `SPECS`.
const KNOWN_KINDS = new Set<string>(Object.keys(SPECS));

/**
 * The kind to capture an instance as. An explicit, recognized override wins over
 * inference; an unrecognized one is ignored in favour of inference rather than
 * indexing into a spec that isn't there — `trace()` must never break its caller.
 */
export function resolveKind(
  target: Record<string, unknown>,
  override?: string,
): TraceKind {
  return override !== undefined && KNOWN_KINDS.has(override)
    ? (override as TraceInstanceKind)
    : inferKind(target);
}

/**
 * Most-specific first, because the overlaps are real: a resource server and a
 * facilitator share the six verify/settle hook names, so the server is
 * identified by a method the facilitator lacks. A server that drops
 * `onVerifiedPaymentCanceled` is therefore read as a facilitator — pass an
 * explicit `kind` to correct that.
 */
function inferKind(target: Record<string, unknown>): TraceKind {
  const has = (method: string): boolean => typeof target[method] === "function";
  if (has("onBeforePayment") || has("onAfterPayment")) return "mcpClient";
  if (has("onProtectedRequest")) return "httpResourceServer";
  if (has("onVerifiedPaymentCanceled")) return "resourceServer";
  if (hooksOf("facilitator").some(has)) return "facilitator";
  if (has("onPaymentRequired")) return "httpClient";
  if (hooksOf("client").some(has)) return "client";
  return "unknown";
}
