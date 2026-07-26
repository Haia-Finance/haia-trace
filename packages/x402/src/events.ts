/**
 * The hook → event mapping: one x402 lifecycle firing becomes one Event Contract
 * event. This is where the adapter's `event_type` vocabulary is defined, where a
 * context is reduced to an allowlisted payload, and where the correlation keys
 * that group a request's events are read off the context.
 *
 * The vocabulary, by hook:
 *
 * | hook                       | event_type                                  |
 * | -------------------------- | ------------------------------------------- |
 * | `onPaymentRequired`        | `x402.payment.required`                     |
 * | `onBeforePaymentCreation`  | `x402.payment.creating`                     |
 * | `onAfterPaymentCreation`   | `x402.payment.submitted`                    |
 * | `onPaymentCreationFailure` | `x402.payment.creation_failed`              |
 * | `onPaymentResponse`        | `x402.payment.responded`                    |
 * | `onBeforePayment` (MCP)    | `x402.payment.requested`                    |
 * | `onAfterPayment` (MCP)     | `x402.payment.responded`                    |
 * | `onProtectedRequest`       | `x402.request.protected`                    |
 * | `onBeforeVerify`           | `x402.verify.started`                       |
 * | `onAfterVerify`            | `x402.verify.ok` / `x402.verify.failed`     |
 * | `onVerifyFailure`          | `x402.verify.failed`                        |
 * | `onBeforeSettle`           | `x402.settle.started`                       |
 * | `onAfterSettle`            | `x402.settle.ok` / `x402.settle.failed`     |
 * | `onSettleFailure`          | `x402.settle.failed`                        |
 * | `onVerifiedPaymentCanceled`| `x402.payment.canceled`                     |
 *
 * The `onAfter*` hooks fire on both outcomes — the SDK reserves `onVerifyFailure`
 * / `onSettleFailure` for a *thrown* fault, while a clean "not valid" or
 * "settlement rejected" arrives as a result on the after-hook. So the after-hooks
 * pick their event type from the result, and a rejection is reported as a failure
 * from either path rather than only from the throwing one.
 *
 * `role` is not decided here: it is fixed by the instance's kind, since the
 * server and the facilitator share these hook names.
 */

import type { EventType } from "@usehaia/trace-core";

import type { CorrelationKeys } from "./correlate.js";
import type { HookContextMap, HookName } from "./hooks.js";
import {
  compact,
  normalizeError,
  normalizePaymentRequired,
  normalizeRequirements,
  normalizeResource,
  normalizeSettleResponse,
  normalizeVerifyResponse,
  type PaymentPayloadLike,
} from "./normalize.js";

/** One hook firing, reduced to what gets recorded and how it is grouped. */
export interface HookEvent extends CorrelationKeys {
  event_type: EventType;
  payload: Record<string, unknown>;
}

/**
 * The value that identifies one payment attempt, read from the scheme-specific
 * signed payload: the nonce in the standard schemes, falling back to the
 * signature when a scheme has no nonce. It is used only as an in-memory grouping
 * key and is never recorded — `normalize.ts` refuses to copy this object.
 */
function paymentAttemptKey(
  paymentPayload: PaymentPayloadLike | undefined,
): string | undefined {
  const signed = paymentPayload?.payload;
  if (signed === undefined) return undefined;
  const authorization = signed.authorization as
    | Record<string, unknown>
    | undefined;
  const attempt =
    authorization?.nonce ?? signed.nonce ?? signed.signature;
  return typeof attempt === "string" ? `payment:${attempt}` : undefined;
}

/** The stand-in key for the hooks that fire before a payment payload exists. */
function resourceKey(url: string | undefined): string | undefined {
  return url === undefined ? undefined : `resource:${url}`;
}

/**
 * Recover the payment payload from the `PAYMENT` request header, the only thing
 * `onProtectedRequest` is handed that identifies the payment. Without it the
 * request that carried a payment could not be grouped with the verify/settle
 * events it triggers.
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

/** A mapper per hook, exhaustive over `HookName` by construction. */
type HookEventMappers = {
  [K in HookName]: (context: HookContextMap[K]) => HookEvent;
};

export const HOOK_EVENTS: HookEventMappers = {
  // `onPaymentRequired` exists on both the HTTP client and the MCP client, whose
  // contexts differ; only the MCP one names a tool.
  onPaymentRequired: (context) => {
    const { paymentRequired } = context;
    const toolName = "toolName" in context ? context.toolName : undefined;
    return {
      event_type: "x402.payment.required",
      payload: compact({
        ...normalizePaymentRequired(paymentRequired),
        tool_name: toolName,
      }),
      coarse:
        toolName !== undefined
          ? `tool:${toolName}`
          : resourceKey(paymentRequired.resource.url),
    };
  },

  onBeforePaymentCreation: ({ paymentRequired, selectedRequirements }) => ({
    event_type: "x402.payment.creating",
    payload: compact({
      x402_version: paymentRequired.x402Version,
      resource: normalizeResource(paymentRequired.resource),
      requirements: normalizeRequirements(selectedRequirements),
    }),
    coarse: resourceKey(paymentRequired.resource.url),
  }),

  onAfterPaymentCreation: ({ paymentRequired, paymentPayload }) => ({
    event_type: "x402.payment.submitted",
    payload: compact({
      x402_version: paymentPayload.x402Version,
      resource: normalizeResource(paymentRequired.resource),
      requirements: normalizeRequirements(paymentPayload.accepted),
    }),
    unique: paymentAttemptKey(paymentPayload),
    coarse: resourceKey(paymentRequired.resource.url),
  }),

  onPaymentCreationFailure: ({
    paymentRequired,
    selectedRequirements,
    error,
  }) => ({
    event_type: "x402.payment.creation_failed",
    payload: compact({
      x402_version: paymentRequired.x402Version,
      resource: normalizeResource(paymentRequired.resource),
      requirements: normalizeRequirements(selectedRequirements),
      error: normalizeError(error),
    }),
    coarse: resourceKey(paymentRequired.resource.url),
  }),

  // The client's view of the whole outcome: a settlement, the server's 402
  // declaration when verification failed, or a transport error.
  onPaymentResponse: ({
    paymentPayload,
    requirements,
    settleResponse,
    paymentRequired,
    error,
  }) => ({
    event_type: "x402.payment.responded",
    payload: compact({
      x402_version: paymentPayload.x402Version,
      resource: normalizeResource(paymentPayload.resource),
      requirements: normalizeRequirements(requirements),
      settle: normalizeSettleResponse(settleResponse),
      payment_required: normalizePaymentRequired(paymentRequired),
      error: normalizeError(error),
    }),
    unique: paymentAttemptKey(paymentPayload),
    coarse: resourceKey(paymentPayload.resource?.url),
  }),

  onBeforePayment: ({ toolName, paymentRequired }) => ({
    event_type: "x402.payment.requested",
    payload: compact({
      ...normalizePaymentRequired(paymentRequired),
      tool_name: toolName,
    }),
    coarse: `tool:${toolName}`,
  }),

  onAfterPayment: ({ toolName, paymentPayload, settleResponse }) => ({
    event_type: "x402.payment.responded",
    payload: compact({
      x402_version: paymentPayload.x402Version,
      resource: normalizeResource(paymentPayload.resource),
      requirements: normalizeRequirements(paymentPayload.accepted),
      settle: normalizeSettleResponse(settleResponse),
      tool_name: toolName,
    }),
    unique: paymentAttemptKey(paymentPayload),
    coarse: `tool:${toolName}`,
  }),

  // The request gate. An unpaid request carries no payment header, so it yields
  // no key and is recorded without a `context_id` — it belongs to no payment yet.
  onProtectedRequest: ({ method, path, routePattern, paymentHeader }) => {
    const paymentPayload = decodePaymentHeader(paymentHeader);
    return {
      event_type: "x402.request.protected",
      payload: compact({
        method,
        path,
        route_pattern: routePattern,
        paid: paymentHeader !== undefined && paymentHeader !== "",
      }),
      unique: paymentAttemptKey(paymentPayload),
    };
  },

  onBeforeVerify: ({ paymentPayload, requirements }) => ({
    event_type: "x402.verify.started",
    payload: compact({
      x402_version: paymentPayload.x402Version,
      resource: normalizeResource(paymentPayload.resource),
      requirements: normalizeRequirements(requirements),
    }),
    unique: paymentAttemptKey(paymentPayload),
  }),

  onAfterVerify: ({ paymentPayload, requirements, result }) => ({
    event_type: result.isValid ? "x402.verify.ok" : "x402.verify.failed",
    payload: compact({
      x402_version: paymentPayload.x402Version,
      resource: normalizeResource(paymentPayload.resource),
      requirements: normalizeRequirements(requirements),
      verify: normalizeVerifyResponse(result),
    }),
    unique: paymentAttemptKey(paymentPayload),
  }),

  onVerifyFailure: ({ paymentPayload, requirements, error }) => ({
    event_type: "x402.verify.failed",
    payload: compact({
      x402_version: paymentPayload.x402Version,
      resource: normalizeResource(paymentPayload.resource),
      requirements: normalizeRequirements(requirements),
      error: normalizeError(error),
    }),
    unique: paymentAttemptKey(paymentPayload),
  }),

  onBeforeSettle: ({ paymentPayload, requirements }) => ({
    event_type: "x402.settle.started",
    payload: compact({
      x402_version: paymentPayload.x402Version,
      resource: normalizeResource(paymentPayload.resource),
      requirements: normalizeRequirements(requirements),
    }),
    unique: paymentAttemptKey(paymentPayload),
  }),

  onAfterSettle: ({ paymentPayload, requirements, result }) => ({
    event_type: result.success ? "x402.settle.ok" : "x402.settle.failed",
    payload: compact({
      x402_version: paymentPayload.x402Version,
      resource: normalizeResource(paymentPayload.resource),
      requirements: normalizeRequirements(requirements),
      settle: normalizeSettleResponse(result),
    }),
    unique: paymentAttemptKey(paymentPayload),
  }),

  onSettleFailure: ({ paymentPayload, requirements, error }) => ({
    event_type: "x402.settle.failed",
    payload: compact({
      x402_version: paymentPayload.x402Version,
      resource: normalizeResource(paymentPayload.resource),
      requirements: normalizeRequirements(requirements),
      error: normalizeError(error),
    }),
    unique: paymentAttemptKey(paymentPayload),
  }),

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
      x402_version: paymentPayload.x402Version,
      resource: normalizeResource(paymentPayload.resource),
      requirements: normalizeRequirements(requirements),
      reason,
      response_status: responseStatus,
      error: normalizeError(error),
    }),
    unique: paymentAttemptKey(paymentPayload),
  }),
};
