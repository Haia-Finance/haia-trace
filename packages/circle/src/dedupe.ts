/**
 * Deduplication of Circle webhook deliveries.
 *
 * Circle delivers at-least-once: a notification the endpoint did not answer
 * with a 2xx is retried, carrying the SAME `notification_id`. The event sink is
 * append-only NDJSON and the receipt assembler deliberately does not dedupe
 * (a duplicate line would be counted twice), so exactly-once has to be
 * enforced here, before anything is written.
 *
 * The store is an interface so the backing can grow into persistence without
 * touching callers. The in-memory default is honest about its limits: bounded
 * (oldest ids fall out past `capacity`) and process-local (a restart forgets
 * everything). Both are fine for replay tooling and short-lived dev servers;
 * a long-lived listener should back this interface with durable storage, or a
 * replayed duplicate that outlives the window will reach the sink.
 */

/** Answers "have we already accepted this notification?" — one method, so a
 *  durable implementation (a table, a KV namespace) is trivial to slot in. */
export interface DedupeStore {
  /**
   * Record `notificationId` and report whether it is new: `true` the first
   * time, `false` for a retry of an already-accepted delivery. (A retry is
   * still answered 200 by the caller — Circle should stop resending.)
   */
  firstSeen(notificationId: string): boolean;
}

export interface MemoryDedupeOptions {
  /** Ids remembered before the oldest are evicted. Default 10 000. */
  capacity?: number;
}

/**
 * The in-memory default: an insertion-ordered Set used as an LRU — a repeat
 * sighting refreshes the id's recency, so under sustained retries the ids
 * evicted first are those genuinely done retrying.
 */
export function createMemoryDedupeStore(
  options: MemoryDedupeOptions = {},
): DedupeStore {
  const capacity = options.capacity ?? 10_000;
  const seen = new Set<string>();

  return {
    firstSeen(notificationId: string): boolean {
      if (seen.has(notificationId)) {
        // Re-insert to move the id to the back of the eviction order.
        seen.delete(notificationId);
        seen.add(notificationId);
        return false;
      }
      if (seen.size >= capacity) {
        // Set iterates in insertion order, so the first value is the oldest.
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      seen.add(notificationId);
      return true;
    },
  };
}
