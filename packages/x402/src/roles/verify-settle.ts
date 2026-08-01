/**
 * The verify/settle exchange, recorded once for the two roles that observe it.
 * A resource server and a facilitator expose the same six hook names with their
 * own context types — different types, identical shape — so the mappers are
 * written against a structural view and type-checked into each role's spec. A
 * role whose payload later diverges overrides the one key.
 *
 * The `onAfter*` hooks have no fixed event type: the SDK reserves the failure
 * hooks for a *thrown* fault, while a clean "not valid" or "settlement
 * rejected" arrives as a result. Reading the outcome off the context is what
 * keeps a failed payment out of a type templates read as proof it went through.
 */

import type { EventType } from "@usehaia/trace-core";
import type { HookEvent } from "../capture/spec.js";
import { paymentAttemptKey } from "../event/correlate.js";
import {
  compact,
  normalizeError,
  normalizeSettleResponse,
  normalizeVerifyResponse,
  type PaymentPayloadLike,
  paymentFacts,
  type RequirementsLike,
  type SettleResponseLike,
  type VerifyResponseLike,
} from "../event/normalize.js";

/** One payment being verified or settled, as both roles' contexts carry it. */
interface Exchange {
  readonly paymentPayload: PaymentPayloadLike;
  readonly requirements: RequirementsLike;
}

const opening =
  (event_type: EventType) =>
  ({ paymentPayload, requirements }: Exchange): HookEvent => ({
    event_type,
    payload: compact(paymentFacts(paymentPayload, requirements)),
    unique: paymentAttemptKey(paymentPayload),
  });

const fault =
  (event_type: EventType) =>
  ({
    paymentPayload,
    requirements,
    error,
  }: Exchange & { readonly error: unknown }): HookEvent => ({
    event_type,
    payload: compact({
      ...paymentFacts(paymentPayload, requirements),
      error: normalizeError(error),
    }),
    unique: paymentAttemptKey(paymentPayload),
  });

export const VERIFY_SETTLE_MAPPERS = {
  onBeforeVerify: opening("x402.verify.started"),

  onAfterVerify: ({
    paymentPayload,
    requirements,
    result,
  }: Exchange & { readonly result: VerifyResponseLike }): HookEvent => ({
    event_type: result.isValid ? "x402.verify.ok" : "x402.verify.failed",
    payload: compact({
      ...paymentFacts(paymentPayload, requirements),
      verify: normalizeVerifyResponse(result),
    }),
    unique: paymentAttemptKey(paymentPayload),
  }),

  onVerifyFailure: fault("x402.verify.failed"),

  onBeforeSettle: opening("x402.settle.started"),

  onAfterSettle: ({
    paymentPayload,
    requirements,
    result,
  }: Exchange & { readonly result: SettleResponseLike }): HookEvent => ({
    event_type: result.success ? "x402.settle.ok" : "x402.settle.failed",
    payload: compact({
      ...paymentFacts(paymentPayload, requirements),
      settle: normalizeSettleResponse(result),
    }),
    unique: paymentAttemptKey(paymentPayload),
  }),

  onSettleFailure: fault("x402.settle.failed"),
};
