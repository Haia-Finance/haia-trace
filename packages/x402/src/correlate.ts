/**
 * Operation correlation — how every event of one request ends up carrying the
 * same `context_id`, which is what lets the assembler tell concurrent payments
 * apart instead of folding them into one receipt.
 *
 * x402 hands each hook a context but no request id, and the adapter must work in
 * browser and edge runtimes where `AsyncLocalStorage` does not exist. So the
 * grouping is derived from the contexts themselves, through two keys that are
 * both identifying — neither is a guess:
 *
 * - A **unique** key is the payment payload's per-payment nonce. It identifies
 *   one payment attempt, and it travels with the payment, so a client and a
 *   server traced in the same process resolve the same payment to the same
 *   `context_id` — both sides of one operation assemble into one receipt.
 * - An **anchor** is the `PaymentRequired` object itself, for the hooks that fire
 *   before a payment payload exists. The x402 client threads one such object by
 *   reference from the 402 response through payment creation, so *identity*
 *   distinguishes two concurrent purchases of the same resource — which their
 *   content, being byte-identical, cannot.
 *
 * Anchors are held in a WeakMap: an anchor belongs to exactly one payment by
 * construction, so it never has to be retired, and it is collected with the
 * object it keys. Only the nonce map needs a bound.
 *
 * The one case that yields no id at all is a firing with neither key — an unpaid
 * protected request, say. Those are recorded without a `context_id` and the
 * assembler keeps them out of every receipt rather than guessing.
 */

/** The keys one hook firing offers the correlator; either may be absent. */
export interface CorrelationKeys {
  /** Identifies one payment attempt exactly — the payload's nonce. */
  unique?: string;
  /**
   * The object the SDK threads through the hooks that fire before a payload
   * exists. Matched by identity, never by content.
   */
  anchor?: object;
}

export interface Correlator {
  /** The operation id for a firing, or `undefined` when nothing identifies one. */
  resolve(keys: CorrelationKeys): string | undefined;
}

export interface CorrelatorOptions {
  /**
   * Mints the id for a newly seen operation. The default is a per-correlator
   * counter (`op-1`, `op-2`, …): unique within the run, which is the scope
   * `context_id` is read back in, and reproducible so golden tests stay stable.
   */
  newContextId?: () => string;
  /**
   * Cap on live nonce keys. A payment has no "operation finished" hook, so the
   * map is bounded and evicts least-recently-used. Reaching the cap only costs
   * grouping for an operation that has been idle for `maxKeys` other operations.
   */
  maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 1024;

export function createCorrelator(options: CorrelatorOptions = {}): Correlator {
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  let operations = 0;
  const newContextId = options.newContextId ?? (() => `op-${++operations}`);

  // Insertion-ordered, so the first key is the least recently used one.
  const byNonce = new Map<string, string>();
  const byAnchor = new WeakMap<object, string>();

  const remember = (nonce: string, contextId: string): void => {
    // Re-insert so a key that is still in use moves to the back of the eviction order.
    byNonce.delete(nonce);
    byNonce.set(nonce, contextId);
    if (byNonce.size > maxKeys) {
      const oldest = byNonce.keys().next();
      if (!oldest.done) byNonce.delete(oldest.value);
    }
  };

  return {
    resolve({ unique, anchor }: CorrelationKeys): string | undefined {
      if (unique === undefined && anchor === undefined) return undefined;

      const contextId =
        (unique !== undefined ? byNonce.get(unique) : undefined) ??
        (anchor !== undefined ? byAnchor.get(anchor) : undefined) ??
        newContextId();

      if (unique !== undefined) remember(unique, contextId);
      // Re-binding an anchor that already resolved is a no-op; binding one that
      // did not is what carries the operation from the pre-payment hooks onto
      // the nonce the rest of the payment is keyed by.
      if (anchor !== undefined) byAnchor.set(anchor, contextId);
      return contextId;
    },
  };
}
