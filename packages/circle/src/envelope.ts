/**
 * The Circle webhook v2 notification envelope — the shape every v2 product
 * (Wallets, Contracts, Gateway) delivers, regardless of the resource inside.
 * Reference: https://developers.circle.com/api-reference/webhooks
 *
 * The envelope is untrusted input from the network, so it is validated loudly
 * before anything downstream touches it — a malformed notification must fail
 * with a sourced error, never silently produce a half-empty event (the same
 * receipt-integrity rule core's template validation follows).
 *
 * Delivery semantics that shape the consumers of this module:
 * - At-least-once: the same notification can arrive again on retry, carrying
 *   the SAME `notification_id` — which is what makes it the dedupe key.
 * - Unordered: a later state can arrive before an earlier one, so processing
 *   keys off the state inside `notification`, never off arrival order.
 */

/** One v2 notification as delivered: the envelope around the resource payload. */
export interface NotificationEnvelope {
  /** The subscription that produced this delivery. */
  subscription_id: string;
  /** Unique per notification and REUSED on retries — the deduplication key. */
  notification_id: string;
  /** What happened, e.g. `transactions.inbound`, `contracts.eventLog`. */
  notification_type: string;
  /**
   * The resource in its current state. Its shape is the corresponding API's
   * response object and belongs to the product, not the envelope — kept opaque
   * here; normalization picks allowlisted fields out of it.
   */
  notification: Record<string, unknown>;
  /** When Circle sent the notification (ISO-8601). The time of *delivery*, not of the underlying fact. */
  timestamp: string;
  /** Envelope version; this module accepts only v2. */
  version: 2;
}

/** Read a raw-body value as UTF-8 text. `TextDecoder` is a global in Node >= 20,
 *  browsers, and edge runtimes; read off `globalThis` with a local type so this
 *  module needs neither `lib: ["DOM"]` nor `@types/node`. */
type TextDecoderLike = { decode(input: Uint8Array): string };
function decodeUtf8(bytes: Uint8Array): string {
  const ctor = (
    globalThis as unknown as { TextDecoder: new () => TextDecoderLike }
  ).TextDecoder;
  return new ctor().decode(bytes);
}

/**
 * Validate an untrusted parsed value into a `NotificationEnvelope`, throwing a
 * sourced `Error` on the first mismatch.
 *
 * Notes on individual rules:
 * - `notification_id` empty would silently disable deduplication (every retry
 *   would look fresh), so it is rejected as hard as a missing field.
 * - `version` must be exactly 2: a v1 (Amazon SNS) message has a different
 *   envelope and signature scheme, and accepting one quietly would bypass both.
 */
export function assertNotificationEnvelope(
  value: unknown,
  source = "<notification>",
): NotificationEnvelope {
  const fail = (why: string): never => {
    throw new Error(`invalid circle notification (${source}): ${why}`);
  };

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("expected an object at the top level");
  }
  const n = value as Record<string, unknown>;

  if (typeof n.subscriptionId !== "string" || n.subscriptionId === "")
    fail("`subscriptionId` must be a non-empty string");
  if (typeof n.notificationId !== "string" || n.notificationId === "")
    fail("`notificationId` must be a non-empty string");
  if (typeof n.notificationType !== "string" || n.notificationType === "")
    fail("`notificationType` must be a non-empty string");
  if (
    typeof n.notification !== "object" ||
    n.notification === null ||
    Array.isArray(n.notification)
  ) {
    fail("`notification` must be an object");
  }
  if (typeof n.timestamp !== "string" || n.timestamp === "")
    fail("`timestamp` must be a non-empty string");
  if (n.version !== 2) fail("`version` must be 2");

  return {
    subscription_id: n.subscriptionId as string,
    notification_id: n.notificationId as string,
    notification_type: n.notificationType as string,
    notification: n.notification as Record<string, unknown>,
    timestamp: n.timestamp as string,
    version: 2,
  };
}

/**
 * Parse a raw request body into a validated envelope.
 *
 * Takes the body as received (`string` or bytes) — the same raw value signature
 * verification runs on — so callers never hold two competing representations of
 * the request. Throws a sourced error on malformed JSON or a bad envelope.
 */
export function parseNotificationEnvelope(
  rawBody: string | Uint8Array,
  source = "<notification>",
): NotificationEnvelope {
  const text = typeof rawBody === "string" ? rawBody : decodeUtf8(rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `invalid circle notification (${source}): malformed JSON: ${(err as Error).message}`,
    );
  }
  return assertNotificationEnvelope(parsed, source);
}
