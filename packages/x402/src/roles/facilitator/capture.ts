/**
 * What the facilitator records: the verify/settle exchange and nothing else —
 * it has no request gate and no cancellation hook.
 *
 * Its events share the seller's vocabulary, so only `role` tells the two apart.
 * That is deliberate: both are witnesses to the same verification and the same
 * settlement, seen from different sides.
 *
 * One asymmetry is worth knowing, because it shows up in the payload rather than
 * the event type. The facilitator calls `onAfterVerify` only for a payment it
 * accepted; a clean "not valid" is delivered to `onVerifyFailure` instead, with
 * an `Error` the SDK builds from the reason. A resource server does the
 * opposite — its `onAfterVerify` fires for an accepted *and* a declined payment,
 * and `onVerifyFailure` is reserved for a thrown fault.
 *
 * So both roles report a decline as `x402.verify.failed`, and a template reads
 * it the same way, but the facilitator's carries `error.message` where the
 * server's carries `verify.invalid_reason`. The reason is not lifted out of that
 * message here: nothing in the context distinguishes a reason the SDK wrapped
 * from a genuine thrown fault, and inventing the difference is the kind of guess
 * this recorder exists to avoid.
 */

import { defineCapture } from "../../spec.js";
import { VERIFY_SETTLE_MAPPERS } from "../verify-settle.js";
import type { FacilitatorHooks } from "./hooks.js";

export const FACILITATOR_SPEC = defineCapture<FacilitatorHooks>({
  kind: "facilitator",
  role: "facilitator",
  mappers: VERIFY_SETTLE_MAPPERS,
});
