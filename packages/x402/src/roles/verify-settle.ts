/**
 * The verify/settle exchange, recorded once for the two roles that observe it.
 *
 * | hook              | event_type                              |
 * | ----------------- | --------------------------------------- |
 * | `onBeforeVerify`  | `x402.verify.started`                   |
 * | `onAfterVerify`   | `x402.verify.ok` / `x402.verify.failed` |
 * | `onVerifyFailure` | `x402.verify.failed`                    |
 * | `onBeforeSettle`  | `x402.settle.started`                   |
 * | `onAfterSettle`   | `x402.settle.ok` / `x402.settle.failed` |
 * | `onSettleFailure` | `x402.settle.failed`                    |
 *
 * A resource server and a facilitator expose these same six hook names, and the
 * SDK hands each of them its own context types — different types, identical
 * shape. So the mappers are written against a structural view of that shape and
 * placed into each role's spec, where the compiler checks they really do fit
 * that role's contexts. A role whose payload later diverges overrides the one key.
 *
 * `role` is not decided here: it is fixed by the instance's kind, which is the
 * only thing that tells these two apart.
 *
 * The `onAfter*` hooks have no fixed event type. The SDK reserves
 * `onVerifyFailure` / `onSettleFailure` for a *thrown* fault, while a clean "not
 * valid" or "settlement rejected" arrives as a result — so the outcome is read
 * off the context rather than assumed, and a failed payment is never recorded
 * under a type a template reads as proof the payment went through.
 */

import type { EventType } from "@usehaia/trace-core";

import { paymentAttemptKey } from "../correlate.js";
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
} from "../normalize.js";
import type { HookEvent } from "../spec.js";

/** One payment being verified or settled, as both roles' contexts carry it. */
interface Exchange {
  readonly paymentPayload: PaymentPayloadLike;
  readonly requirements: RequirementsLike;
}

/** A hook that fires before the SDK acts — nothing to report but the payment itself. */
const opening =
  (event_type: EventType) =>
  ({ paymentPayload, requirements }: Exchange): HookEvent => ({
    event_type,
    payload: compact(paymentFacts(paymentPayload, requirements)),
    unique: paymentAttemptKey(paymentPayload),
  });

/** A hook that fires on a thrown fault, which the receipt has to be able to explain. */
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
