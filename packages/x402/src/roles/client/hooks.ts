/**
 * The payer's hook surface — the three client kinds and the context each of
 * their hooks is handed.
 *
 * The SDK's context interfaces are `import type` only, which the compiler
 * erases: nothing reaches `dist/`, so the package keeps zero runtime
 * dependencies and detection stays pure duck-typing.
 */

import type {
  PaymentRequiredContext as HttpPaymentRequiredContext,
  PaymentCreatedContext,
  PaymentCreationContext,
  PaymentCreationFailureContext,
  PaymentResponseContext,
} from "@x402/core/client";
import type {
  // `onAfterPayment`'s context is inline in the SDK, not a named export.
  AfterPaymentHook,
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

/** x402HTTPClient — the client hooks plus the payment-required retry hook. */
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
