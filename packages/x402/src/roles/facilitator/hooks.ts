/**
 * The facilitator's hook surface: the same six verify/settle names a resource
 * server exposes, with its own context types and — the discriminant — without
 * `onVerifiedPaymentCanceled`. `import type` only, so no `@x402` value reaches
 * `dist/`.
 */

import type {
  FacilitatorSettleContext,
  FacilitatorSettleFailureContext,
  FacilitatorSettleResultContext,
  FacilitatorVerifyContext,
  FacilitatorVerifyFailureContext,
  FacilitatorVerifyResultContext,
} from "@x402/core/facilitator";

/** x402Facilitator. */
export interface FacilitatorHooks {
  onBeforeVerify: FacilitatorVerifyContext;
  onAfterVerify: FacilitatorVerifyResultContext;
  onVerifyFailure: FacilitatorVerifyFailureContext;
  onBeforeSettle: FacilitatorSettleContext;
  onAfterSettle: FacilitatorSettleResultContext;
  onSettleFailure: FacilitatorSettleFailureContext;
}
