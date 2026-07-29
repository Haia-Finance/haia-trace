/**
 * What the payer records: one mapper per hook, one spec per client kind. Every
 * failure type produced here is an exception in the shipped buyer template.
 */

import type { EventType } from "@usehaia/trace-core";

import { paymentAttemptKey } from "../../correlate.js";
import {
  compact,
  normalizeError,
  normalizePaymentRequired,
  normalizeRequirements,
  normalizeResource,
  normalizeSettleResponse,
  type PaymentRequiredLike,
  paymentFacts,
} from "../../normalize.js";
import { defineCapture, type HookEvent, type HookMappers } from "../../spec.js";
import type { ClientHooks, HttpClientHooks, McpClientHooks } from "./hooks.js";

/**
 * The outcome the client observed, read off the discriminant `@x402/core`
 * documents on its response context. Only a settlement that actually succeeded
 * may report `x402.payment.responded` — that event is the client-side witness a
 * template reads as "the payment settled", and an over-reported fault is
 * visible where an over-reported settlement is a lie.
 */
function paymentOutcome(
  settle: { readonly success: boolean } | undefined | null,
  absent: EventType,
): EventType {
  if (settle === undefined || settle === null) return absent;
  return settle.success ? "x402.payment.responded" : "x402.settle.failed";
}

/**
 * A 402 offer as the payer received it — shared by the challenge hook and, on
 * MCP, the one naming a tool. The offer object is the anchor: the SDK threads it
 * by reference from the 402 response through payment creation, so its identity
 * separates two concurrent purchases of the same resource.
 */
const offerEvent = (
  event_type: EventType,
  paymentRequired: PaymentRequiredLike,
  toolName?: string,
): HookEvent => ({
  event_type,
  payload: compact({
    ...normalizePaymentRequired(paymentRequired),
    tool_name: toolName,
  }),
  anchor: paymentRequired,
});

const CLIENT_MAPPERS: HookMappers<ClientHooks> = {
  onBeforePaymentCreation: ({ paymentRequired, selectedRequirements }) => ({
    event_type: "x402.payment.creating",
    payload: compact(paymentFacts(paymentRequired, selectedRequirements)),
    anchor: paymentRequired,
  }),

  onAfterPaymentCreation: ({ paymentRequired, paymentPayload }) => ({
    event_type: "x402.payment.submitted",
    payload: compact({
      // Version and terms from the payload just signed; the resource from the
      // offer it answers, which is where the server declared it.
      x402_version: paymentPayload.x402Version,
      resource: normalizeResource(paymentRequired.resource),
      requirements: normalizeRequirements(paymentPayload.accepted),
    }),
    unique: paymentAttemptKey(paymentPayload),
    anchor: paymentRequired,
  }),

  onPaymentCreationFailure: ({
    paymentRequired,
    selectedRequirements,
    error,
  }) => ({
    event_type: "x402.payment.creation_failed",
    payload: compact({
      ...paymentFacts(paymentRequired, selectedRequirements),
      error: normalizeError(error),
    }),
    anchor: paymentRequired,
  }),

  // The client's view of the whole outcome: a settlement, the server's fresh 402
  // when verification failed, or a transport error with neither.
  onPaymentResponse: ({
    paymentPayload,
    requirements,
    settleResponse,
    paymentRequired,
    error,
  }) => ({
    event_type: paymentOutcome(
      settleResponse,
      paymentRequired !== undefined
        ? "x402.verify.failed"
        : "x402.payment.failed",
    ),
    payload: compact({
      ...paymentFacts(paymentPayload, requirements),
      settle: normalizeSettleResponse(settleResponse),
      payment_required: normalizePaymentRequired(paymentRequired),
      error: normalizeError(error),
    }),
    unique: paymentAttemptKey(paymentPayload),
  }),
};

export const CLIENT_SPEC = defineCapture<ClientHooks>({
  kind: "client",
  role: "client",
  mappers: CLIENT_MAPPERS,
});

export const HTTP_CLIENT_SPEC = defineCapture<HttpClientHooks>({
  kind: "httpClient",
  role: "client",
  mappers: {
    ...CLIENT_MAPPERS,
    onPaymentRequired: ({ paymentRequired }) =>
      offerEvent("x402.payment.required", paymentRequired),
  },
  inner: { props: ["client"], kind: "client" },
});

export const MCP_CLIENT_SPEC = defineCapture<McpClientHooks>({
  kind: "mcpClient",
  role: "client",
  mappers: {
    onPaymentRequired: ({ paymentRequired, toolName }) =>
      offerEvent("x402.payment.required", paymentRequired, toolName),

    onBeforePayment: ({ paymentRequired, toolName }) =>
      offerEvent("x402.payment.requested", paymentRequired, toolName),

    // A `settleResponse` of `null` is how the MCP client says the paid call came
    // back unsettled — a fault like any other missing settlement.
    onAfterPayment: ({ toolName, paymentPayload, settleResponse }) => ({
      event_type: paymentOutcome(settleResponse, "x402.payment.failed"),
      payload: compact({
        ...paymentFacts(paymentPayload, paymentPayload.accepted),
        settle: normalizeSettleResponse(settleResponse),
        tool_name: toolName,
      }),
      unique: paymentAttemptKey(paymentPayload),
    }),
  },
});
