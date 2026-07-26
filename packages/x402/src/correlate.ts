/**
 * Operation correlation — how every event of one request ends up carrying the
 * same `context_id`, which is what lets the assembler tell concurrent payments
 * apart instead of folding them into one receipt.
 *
 * x402 hands each hook a context but no request id, and the adapter must work in
 * browser and edge runtimes where `AsyncLocalStorage` does not exist. So the
 * grouping is derived from the contexts themselves: each firing yields up to two
 * keys, and a key that has been seen before pulls the firing into that key's
 * operation.
 *
 * The two key tiers are not equally trustworthy, and the difference is the whole
 * design:
 *
 * - A **unique** key comes from the payment payload's per-payment nonce, so it
 *   identifies exactly one payment attempt. Two concurrent payments never share
 *   one.
 * - A **coarse** key (the resource URL, the MCP tool name) is all that exists
 *   before a payment payload has been created. It identifies *what* is being
 *   paid for, not *which* attempt, so two concurrent requests for the same
 *   resource would collide on it.
 *
 * A coarse key is therefore treated as a short-lived stand-in: the moment a
 * firing arrives carrying a unique key, the coarse key is retired from the map,
 * so the next request for that resource opens a fresh operation rather than
 * joining the one already under way. That confines the collision window to the
 * few hooks between "402 received" and "payment created".
 *
 * Because the unique key is derived from the payment itself, a client and a
 * server traced in the same process land on the same `context_id` for the same
 * payment — both sides of one operation assemble into one receipt.
 */

/** The keys one hook firing offers the correlator; either may be absent. */
export interface CorrelationKeys {
  /** Identifies one payment attempt exactly. */
  unique?: string;
  /** Identifies the resource being paid for; a stand-in until `unique` exists. */
  coarse?: string;
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
   * Cap on live keys. Keys are never explicitly retired on success — a payment
   * has no "operation finished" hook — so the map is bounded and evicts
   * least-recently-used. Reaching the cap only costs grouping for an operation
   * that has been idle for `maxKeys` other operations.
   */
  maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 1024;

export function createCorrelator(options: CorrelatorOptions = {}): Correlator {
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  let operations = 0;
  const newContextId = options.newContextId ?? (() => `op-${++operations}`);

  // Insertion-ordered, so the first key is the least recently used one.
  const contextIds = new Map<string, string>();

  const remember = (key: string, contextId: string): void => {
    // Re-insert so a key that is still in use moves to the back of the eviction order.
    contextIds.delete(key);
    contextIds.set(key, contextId);
    if (contextIds.size > maxKeys) {
      const oldest = contextIds.keys().next();
      if (!oldest.done) contextIds.delete(oldest.value);
    }
  };

  return {
    resolve({ unique, coarse }: CorrelationKeys): string | undefined {
      if (unique === undefined && coarse === undefined) return undefined;

      const contextId =
        (unique !== undefined ? contextIds.get(unique) : undefined) ??
        (coarse !== undefined ? contextIds.get(coarse) : undefined) ??
        newContextId();

      if (unique !== undefined) remember(unique, contextId);
      if (coarse !== undefined) {
        // Once a payment-unique key carries the operation the stand-in has done
        // its job; keeping it would hand the next request for the same resource
        // to this operation.
        if (unique === undefined) remember(coarse, contextId);
        else contextIds.delete(coarse);
      }
      return contextId;
    },
  };
}
