/**
 * Grouping one request's events under a single `context_id`, which is what lets
 * the assembler tell concurrent payments apart.
 *
 * x402 hands hooks no request id, and the adapter must work where
 * `AsyncLocalStorage` does not exist, so grouping is derived from the contexts
 * themselves through two keys that are both identifying — neither is a guess.
 */

/** The keys one hook firing offers the correlator; either may be absent. */
export interface CorrelationKeys {
  /** Identifies one payment attempt exactly — the payload's nonce. */
  unique?: string;
  /**
   * The object the SDK threads by reference through the hooks that fire before a
   * payload exists. Matched by identity, never by content: two concurrent
   * purchases of the same resource have byte-identical offers.
   */
  anchor?: object;
}

export interface Correlator {
  /** The operation id for a firing, or `undefined` when nothing identifies one. */
  resolve(keys: CorrelationKeys): string | undefined;
}

interface SignedPayment {
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * The unique key of one payment attempt: the nonce in the standard schemes,
 * falling back to the signature when a scheme has no nonce. Grouping only —
 * `normalize.ts` refuses to copy the object it comes from, so it is never
 * recorded.
 */
export function paymentAttemptKey(
  payment: SignedPayment | undefined,
): string | undefined {
  const signed = payment?.payload;
  if (signed === undefined) return undefined;
  const authorization = signed.authorization as
    | Record<string, unknown>
    | undefined;
  const attempt = authorization?.nonce ?? signed.nonce ?? signed.signature;
  return typeof attempt === "string" ? `payment:${attempt}` : undefined;
}

export interface CorrelatorOptions {
  /**
   * Mints the id for a newly seen operation. Default: a per-correlator counter
   * (`op-1`, `op-2`, …) — unique within the run, and reproducible so golden
   * tests stay stable.
   */
  newContextId?: () => string;
  /**
   * Cap on live nonce keys. A payment has no "operation finished" hook, so the
   * map is bounded and evicts least-recently-used.
   */
  maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 1024;

export function createCorrelator(options: CorrelatorOptions = {}): Correlator {
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  let operations = 0;
  const newContextId = options.newContextId ?? (() => `op-${++operations}`);

  // Insertion-ordered, so the first key is the least recently used one. Anchors
  // need no bound: one belongs to exactly one payment and is collected with it.
  const byNonce = new Map<string, string>();
  const byAnchor = new WeakMap<object, string>();

  const remember = (nonce: string, contextId: string): void => {
    // Re-insert so a key still in use moves to the back of the eviction order.
    byNonce.delete(nonce);
    byNonce.set(nonce, contextId);
    if (byNonce.size > maxKeys) {
      const oldest = byNonce.keys().next();
      if (!oldest.done) byNonce.delete(oldest.value);
    }
  };

  return {
    resolve({ unique, anchor }: CorrelationKeys): string | undefined {
      // A firing with neither key — an unpaid protected request, say — is
      // recorded without a `context_id` rather than guessed into an operation.
      if (unique === undefined && anchor === undefined) return undefined;

      const contextId =
        (unique !== undefined ? byNonce.get(unique) : undefined) ??
        (anchor !== undefined ? byAnchor.get(anchor) : undefined) ??
        newContextId();

      if (unique !== undefined) remember(unique, contextId);
      // Binding an anchor that did not resolve is what carries the operation
      // from the pre-payment hooks onto the nonce the rest is keyed by.
      if (anchor !== undefined) byAnchor.set(anchor, contextId);
      return contextId;
    },
  };
}
