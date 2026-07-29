/**
 * What the facilitator records: the verify/settle exchange and nothing else —
 * it has no request gate and no cancellation hook.
 *
 * Its events share the seller's vocabulary, so only `role` tells the two apart.
 * That is deliberate: both are witnesses to the same verification and the same
 * settlement, seen from different sides.
 */

import { defineCapture } from "../../spec.js";
import { VERIFY_SETTLE_MAPPERS } from "../verify-settle.js";
import type { FacilitatorHooks } from "./hooks.js";

export const FACILITATOR_SPEC = defineCapture<FacilitatorHooks>({
  kind: "facilitator",
  role: "facilitator",
  mappers: VERIFY_SETTLE_MAPPERS,
});
