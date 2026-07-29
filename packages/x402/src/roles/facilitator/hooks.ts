/**
 * The facilitator's hook surface — the same six verify/settle hook names a
 * resource server exposes, but its own context types, and (the discriminant)
 * without `onVerifiedPaymentCanceled`.
 *
 * Hooks reference: https://docs.x402.org/advanced-concepts/lifecycle-hooks
 *
 * `import type` is erased by the compiler, so no `@x402` value reaches `dist/`.
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
