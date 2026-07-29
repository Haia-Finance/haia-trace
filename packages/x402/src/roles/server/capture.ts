/**
 * What the payee records: the verify/settle exchange it shares with the
 * facilitator, plus the two hooks only a resource server has.
 *
 * | hook                        | event_type               |
 * | --------------------------- | ------------------------ |
 * | `onProtectedRequest`        | `x402.request.protected` |
 * | `onVerifiedPaymentCanceled` | `x402.payment.canceled`  |
 *
 * Every failure type produced here is listed in the `exceptions` of the shipped
 * seller template, so a fault surfaces on the receipt instead of passing silently.
 */

import { paymentAttemptKey } from "../../correlate.js";
import {
  compact,
  normalizeError,
  type PaymentPayloadLike,
  paymentFacts,
} from "../../normalize.js";
import { defineCapture, type HookMappers } from "../../spec.js";
import { VERIFY_SETTLE_MAPPERS } from "../verify-settle.js";
import type { HttpResourceServerHooks, ResourceServerHooks } from "./hooks.js";

/**
 * Recover the payment payload from the `PAYMENT` request header — the only thing
 * `onProtectedRequest` is handed that identifies the payment, and so the only
 * way the request that carried one is grouped with the verify/settle events it
 * triggers.
 *
 * Every step is best-effort: `atob` is absent in some runtimes, the header is
 * absent on the first (unpaid) request, and a v1 or malformed header will not
 * parse. Any of those yields `undefined`, which costs grouping for one event and
 * nothing else.
 */
function decodePaymentHeader(
  header: string | undefined,
): PaymentPayloadLike | undefined {
  if (header === undefined || header === "") return undefined;
  const decode = (globalThis as { atob?: (value: string) => string }).atob;
  if (typeof decode !== "function") return undefined;
  try {
    return JSON.parse(decode(header)) as PaymentPayloadLike;
  } catch {
    return undefined;
  }
}

// Annotated rather than inferred: the annotation is what rejects a mapper for a
// hook this kind does not have, which an inferred object literal assigned to a
// variable would let through.
const RESOURCE_SERVER_MAPPERS: HookMappers<ResourceServerHooks> = {
  ...VERIFY_SETTLE_MAPPERS,

  // A payment that verified but was rolled back because the paid work did not
  // complete — the receipt has to show it as a fault, not as a settlement.
  onVerifiedPaymentCanceled: ({
    paymentPayload,
    requirements,
    reason,
    responseStatus,
    error,
  }) => ({
    event_type: "x402.payment.canceled",
    payload: compact({
      ...paymentFacts(paymentPayload, requirements),
      reason,
      response_status: responseStatus,
      error: normalizeError(error),
    }),
    unique: paymentAttemptKey(paymentPayload),
  }),
};

export const RESOURCE_SERVER_SPEC = defineCapture<ResourceServerHooks>({
  kind: "resourceServer",
  role: "server",
  mappers: RESOURCE_SERVER_MAPPERS,
});

export const HTTP_RESOURCE_SERVER_SPEC = defineCapture<HttpResourceServerHooks>(
  {
    kind: "httpResourceServer",
    role: "server",
    mappers: {
      ...RESOURCE_SERVER_MAPPERS,

      // The request gate. An unpaid request carries no payment header, so it
      // yields no key and is recorded without a `context_id` — it belongs to no
      // payment yet.
      onProtectedRequest: ({ method, path, routePattern, paymentHeader }) => ({
        event_type: "x402.request.protected",
        payload: compact({
          method,
          path,
          route_pattern: routePattern,
          paid: paymentHeader !== undefined && paymentHeader !== "",
        }),
        unique: paymentAttemptKey(decodePaymentHeader(paymentHeader)),
      }),
    },
    // `server` is the documented getter; the private field it reads is the fallback.
    inner: { props: ["server", "ResourceServer"], kind: "resourceServer" },
  },
);
