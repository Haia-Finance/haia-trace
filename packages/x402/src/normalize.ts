/**
 * The redaction allowlist — the answer to "what of a hook's context gets
 * recorded". The Event Contract requires an event's `payload` to be normalized
 * and redacted, never the raw captured context, so nothing reaches an event
 * except by passing through a function here.
 *
 * It is an allowlist, not a denylist: each protocol object is rebuilt field by
 * field, so a field the x402 SDK adds in a later version is dropped by default
 * rather than silently recorded. Two things are deliberately never copied:
 *
 * - `PaymentPayload.payload` — the scheme-specific signed authorization. This is
 *   the credential that moves the money; it must never be written to disk.
 * - `extra` / `extensions` — open-ended bags whose contents are defined by
 *   schemes and third-party extensions, so their safety cannot be reasoned about
 *   here.
 *
 * Output keys are snake_case, matching the rest of the contract, and absent
 * fields are omitted rather than written as `null`.
 *
 * The parameter types are local structural views of the x402 protocol objects,
 * not the SDK's own types. Server hooks hand out `DeepReadonly<…>` variants of
 * the same shapes, and a readonly view is structurally assignable to these — one
 * normalizer per object therefore covers the client, server, and facilitator
 * spellings alike.
 */

interface ResourceLike {
  readonly url: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly serviceName?: string;
}

interface RequirementsLike {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
}

export interface PaymentRequiredLike {
  readonly x402Version: number;
  readonly error?: string;
  readonly resource: ResourceLike;
  readonly accepts: readonly RequirementsLike[];
}

export interface PaymentPayloadLike {
  readonly x402Version: number;
  readonly resource?: ResourceLike;
  readonly accepted: RequirementsLike;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface VerifyResponseLike {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly invalidMessage?: string;
  readonly payer?: string;
}

interface SettleResponseLike {
  readonly success: boolean;
  readonly errorReason?: string;
  readonly errorMessage?: string;
  readonly payer?: string;
  readonly transaction: string;
  readonly network: string;
  readonly amount?: string;
}

/** Drop the keys whose value is absent, so an optional field is omitted rather than recorded as `undefined`. */
export function compact(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

export function normalizeResource(
  resource: ResourceLike | undefined,
): Record<string, unknown> | undefined {
  if (resource === undefined) return undefined;
  return compact({
    url: resource.url,
    description: resource.description,
    mime_type: resource.mimeType,
    service_name: resource.serviceName,
  });
}

export function normalizeRequirements(
  requirements: RequirementsLike | undefined,
): Record<string, unknown> | undefined {
  if (requirements === undefined) return undefined;
  return compact({
    scheme: requirements.scheme,
    network: requirements.network,
    asset: requirements.asset,
    amount: requirements.amount,
    pay_to: requirements.payTo,
    max_timeout_seconds: requirements.maxTimeoutSeconds,
  });
}

/** The full 402 offer, as the server declared it. */
export function normalizePaymentRequired(
  paymentRequired: PaymentRequiredLike | undefined,
): Record<string, unknown> | undefined {
  if (paymentRequired === undefined) return undefined;
  return compact({
    x402_version: paymentRequired.x402Version,
    error: paymentRequired.error,
    resource: normalizeResource(paymentRequired.resource),
    accepts: paymentRequired.accepts.map(normalizeRequirements),
  });
}

export function normalizeVerifyResponse(
  result: VerifyResponseLike | undefined,
): Record<string, unknown> | undefined {
  if (result === undefined) return undefined;
  return compact({
    is_valid: result.isValid,
    invalid_reason: result.invalidReason,
    invalid_message: result.invalidMessage,
    payer: result.payer,
  });
}

export function normalizeSettleResponse(
  result: SettleResponseLike | undefined | null,
): Record<string, unknown> | undefined {
  if (result === undefined || result === null) return undefined;
  return compact({
    success: result.success,
    transaction: result.transaction,
    network: result.network,
    amount: result.amount,
    payer: result.payer,
    error_reason: result.errorReason,
    error_message: result.errorMessage,
  });
}

/**
 * A fault, reduced to what a receipt needs to explain it. The stack is dropped —
 * it carries file paths and, in some SDKs, interpolated argument values.
 * `VerifiedPaymentCanceledContext.error` is typed `unknown`, so a non-Error
 * throw has to be handled too; `String()` on an arbitrary object yields
 * `[object Object]` rather than its contents, which is the safe direction here.
 */
export function normalizeError(
  error: unknown,
): Record<string, unknown> | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) {
    return compact({ name: error.name, message: error.message });
  }
  return { name: "Error", message: String(error) };
}
