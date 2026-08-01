/**
 * What the facilitator records: the verify/settle exchange and nothing else — it
 * has no request gate and no cancellation hook. Its events share the seller's
 * vocabulary, so only `role` tells the two apart.
 *
 * One asymmetry shows up in the payload rather than the event type. The
 * facilitator calls `onAfterVerify` only for a payment it accepted; a clean "not
 * valid" goes to `onVerifyFailure` with an `Error` the SDK builds from the
 * reason. A resource server does the opposite. So both report a decline as
 * `x402.verify.failed`, but the facilitator's carries `error.message` where the
 * server's carries `verify.invalid_reason`. The reason is not lifted out of that
 * message: nothing distinguishes a reason the SDK wrapped from a real thrown
 * fault, and inventing the difference is the guess this recorder exists to avoid.
 */

import { defineCapture } from "../../capture/spec.js";
import { VERIFY_SETTLE_MAPPERS } from "../verify-settle.js";
import type { FacilitatorHooks } from "./hooks.js";

export const FACILITATOR_SPEC = defineCapture<FacilitatorHooks>({
  kind: "facilitator",
  role: "facilitator",
  mappers: VERIFY_SETTLE_MAPPERS,
});
