/**
 * The payee's hook surface — the two resource-server kinds and the context each
 * of their hooks is handed.
 *
 * Hooks reference: https://docs.x402.org/advanced-concepts/lifecycle-hooks
 *
 * `import type` is erased by the compiler, so no `@x402` value reaches `dist/`.
 */

import type { HTTPRequestContext } from "@x402/core/http";
import type {
  SettleContext,
  SettleFailureContext,
  SettleResultContext,
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyFailureContext,
  VerifyResultContext,
} from "@x402/core/server";

/**
 * x402ResourceServer. `onVerifiedPaymentCanceled` is the discriminant: a
 * facilitator exposes the same six verify/settle hooks and not this one.
 */
export interface ResourceServerHooks {
  onBeforeVerify: VerifyContext;
  onAfterVerify: VerifyResultContext;
  onVerifyFailure: VerifyFailureContext;
  onBeforeSettle: SettleContext;
  onAfterSettle: SettleResultContext;
  onSettleFailure: SettleFailureContext;
  onVerifiedPaymentCanceled: VerifiedPaymentCanceledContext;
}

/** x402HTTPResourceServer — the resource-server hooks plus the request gate. */
export interface HttpResourceServerHooks extends ResourceServerHooks {
  onProtectedRequest: HTTPRequestContext;
}
