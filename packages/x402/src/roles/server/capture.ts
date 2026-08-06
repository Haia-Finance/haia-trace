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

/** Whatever the context offers to read a request header through. */
interface HeaderSource {
  getHeader(name: string): string | undefined;
}

/** What a context was able to say about the payment header. */
interface PaymentHeaderRead {
  /** The header, when the request carried one. */
  header: string | undefined;
  /** False when the context exposed no way to read a header at all. */
  readable: boolean;
}

/**
 * The header reader a context exposes: the SDK's own `adapter`, or — for a
 * gateway that implements this hook itself — the method on the context.
 *
 * Probed as the foreign object it is, rather than trusted to match the type the
 * SDK declares: a third-party gateway may hand out a context with no `adapter`
 * on it at all, and reading through the type's promise would throw on every
 * protected request. That surfaces as one `trace.capture_failed` per request
 * with the request event itself lost — a whole hook silently unobserved because
 * of a shape the type did not describe.
 */
function headerSource(
  context: HttpResourceServerHooks["onProtectedRequest"],
): HeaderSource | undefined {
  // One view of the context as the foreign object it is; both fields are read
  // off it as optional, whatever the SDK's type promises about them.
  const probe = context as {
    adapter?: Partial<HeaderSource>;
    getHeader?: HeaderSource["getHeader"];
  };
  if (typeof probe.adapter?.getHeader === "function") {
    return probe.adapter as HeaderSource;
  }
  // Returned as the context itself, so a method that reads `this` still works.
  if (typeof probe.getHeader === "function") return probe as HeaderSource;
  return undefined;
}

/**
 * The SDK's HTTP resource server declares `paymentHeader` but never sets it, so
 * the header is read off the context's header source, under the two spellings
 * the SDK itself tries. A source that *throws* is still left unguarded: a broken
 * adapter is a fault worth surfacing as `trace.capture_failed`, where an absent
 * one is merely a shape the SDK's type does not cover.
 */
function readPaymentHeader(
  context: HttpResourceServerHooks["onProtectedRequest"],
): PaymentHeaderRead {
  const { paymentHeader } = context;
  if (paymentHeader) return { header: paymentHeader, readable: true };

  const source = headerSource(context);
  if (source === undefined) return { header: undefined, readable: false };

  const header =
    source.getHeader("payment-signature") ||
    source.getHeader("PAYMENT-SIGNATURE");
  return { header: header || undefined, readable: true };
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
        const { header, readable } = readPaymentHeader(context);
        return {
          event_type: "x402.request.protected",
          payload: compact({
            method: context.method,
            path: context.path,
            route_pattern: context.routePattern,
            // Omitted rather than recorded as `false` when the context offered
            // nothing to read the header through: unpaid and unknown are
            // different facts, and only one of them is safe to assert.
            paid: readable ? header !== undefined : undefined,
          }),
          unique: paymentAttemptKey(decodePaymentHeader(header)),
        };
      },
    },
    // `server` is the documented getter; the private field it reads is the fallback.
    inner: { props: ["server", "ResourceServer"], kind: "resourceServer" },
  },
);
