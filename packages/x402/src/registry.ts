/**
 * The kind registry: every recognized x402 instance kind's capture spec, and how
 * an untyped instance is placed into one.
 *
 * Detection is pure duck-typing — no `@x402` value is imported at runtime — so
 * API-compatible forks are covered and an unrecognized shape degrades to
 * `"unknown"` rather than failing. Reading a kind's hook names off its spec is
 * what keeps the two in step: a hook is registered exactly when it has a mapper.
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

/** Every recognized kind's capture spec. */
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

/**
 * The recognized kinds, as a Set — used to validate a caller-supplied `kind`
 * before it is trusted to index `SPECS`. A Set, not an `in` check, so a prototype
 * key such as `"constructor"` can't slip through.
 */
const KNOWN_KINDS = new Set<string>(Object.keys(SPECS));

/**
 * The kind to capture an instance as. An explicit, recognized override wins over
 * inference; an unrecognized one — a plain-JS caller, or a prototype key such as
 * `"constructor"` — is ignored in favour of inference rather than indexing into
 * a spec that isn't there, because `trace()` must never break the caller it wraps.
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
 * Infer an instance's kind from its method set, checked most-specific first.
 * The overlaps are deliberate: a resource server and a facilitator share the six
 * verify/settle hook names, so the server is identified by a method the
 * facilitator lacks (`onVerifiedPaymentCanceled`, or `onProtectedRequest` on the
 * HTTP server); an instance with verify/settle hooks but neither of those is the
 * facilitator. Purely structural — no `@x402` import, no reliance on class
 * identity — so forks and subclasses are placed the same way.
 *
 * The one inherent ambiguity: a resource server that does not expose
 * `onVerifiedPaymentCanceled` (a fork that renamed or dropped it) is
 * indistinguishable from a facilitator here and is read as one — its
 * verify/settle events would then be tagged `role: "facilitator"`. Pass an
 * explicit `kind` to correct such a case.
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
