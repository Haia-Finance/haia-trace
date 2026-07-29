/**
 * The payer's hook surface — the three client kinds and the context each of
 * their hooks is handed.
 *
 * Hooks reference: https://docs.x402.org/advanced-concepts/lifecycle-hooks
 *
 * The x402 SDK's own context interfaces are imported with `import type`, which
 * the compiler erases: nothing is emitted into `dist/`, so the package keeps its
 * zero runtime dependencies and never imports x402 at runtime. They only shape
 * the context each handler is handed; detecting a kind stays pure duck-typing.
 */

import type {
  // The HTTP client's `onPaymentRequired` context; distinct from the MCP one.
  PaymentRequiredContext as HttpPaymentRequiredContext,
  PaymentCreatedContext,
  PaymentCreationContext,
  PaymentCreationFailureContext,
  PaymentResponseContext,
} from "@x402/core/client";
import type {
  // `onAfterPayment`'s context is an inline anonymous type in the SDK, not a
  // named export — recover it from the hook signature.
  AfterPaymentHook,
  // The MCP client's `onPaymentRequired` context; distinct from the HTTP one.
  PaymentRequiredContext as McpPaymentRequiredContext,
  PaymentRequestedContext,
} from "@x402/mcp";

/** x402Client. */
export interface ClientHooks {
  onBeforePaymentCreation: PaymentCreationContext;
  onAfterPaymentCreation: PaymentCreatedContext;
  onPaymentCreationFailure: PaymentCreationFailureContext;
  onPaymentResponse: PaymentResponseContext;
}

/** x402HTTPClient — the client hooks plus the HTTP payment-required retry hook. */
export interface HttpClientHooks extends ClientHooks {
  onPaymentRequired: HttpPaymentRequiredContext;
}

/**
 * x402MCPClient. The MCP *server* side registers through a config object rather
 * than these methods, so it is not one of these kinds.
 */
export interface McpClientHooks {
  onPaymentRequired: McpPaymentRequiredContext;
  onBeforePayment: PaymentRequestedContext;
  onAfterPayment: Parameters<AfterPaymentHook>[0];
}
