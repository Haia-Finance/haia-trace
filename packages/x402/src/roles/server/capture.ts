/**
 * What the payee records: the verify/settle exchange it shares with the
 * facilitator, plus the two hooks only a resource server has.
 */

import { defineCapture, type HookMappers } from "../../capture/spec.js";
import { paymentAttemptKey } from "../../event/correlate.js";
import {
  compact,
  normalizeError,
  type PaymentPayloadLike,
  paymentFacts,
} from "../../event/normalize.js";
import { VERIFY_SETTLE_MAPPERS } from "../verify-settle.js";
import type { HttpResourceServerHooks, ResourceServerHooks } from "./hooks.js";

// The SDK's HTTP resource server declares `paymentHeader` but never sets it, so
// the header is read off the adapter, under the two spellings the SDK itself
// tries. Unguarded: a throwing adapter surfaces as `trace.capture_failed` in
// `attach.ts`, which beats recording a confident `paid: false` that may be wrong.
function readPaymentHeader({
  paymentHeader,
  adapter,
}: HttpResourceServerHooks["onProtectedRequest"]): string | undefined {
  const header =
    paymentHeader ||
    adapter.getHeader("payment-signature") ||
    adapter.getHeader("PAYMENT-SIGNATURE");
  return header || undefined;
}

/**
 * The payment header is the only thing `onProtectedRequest` carries that
 * identifies the payment, so it is what groups the request with the
 * verify/settle events it triggers. Every step is best-effort — `atob` is absent
 * in some runtimes, the header is absent on the first request, and a v1 or
 * malformed one will not parse — and failing costs grouping, nothing else.
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
// hook this kind does not have.
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

      // The first request of a payment carries no header, so it yields no key
      // and is recorded without a `context_id` — it belongs to no payment yet.
      // The paid retry does, and opens the operation the verify/settle events
      // then join.
      onProtectedRequest: (context) => {
        const paymentHeader = readPaymentHeader(context);
        return {
          event_type: "x402.request.protected",
          payload: compact({
            method: context.method,
            path: context.path,
            route_pattern: context.routePattern,
            paid: paymentHeader !== undefined,
          }),
          unique: paymentAttemptKey(decodePaymentHeader(paymentHeader)),
        };
      },
    },
    // `server` is the documented getter; the private field it reads is the fallback.
    inner: { props: ["server", "ResourceServer"], kind: "resourceServer" },
  },
);
