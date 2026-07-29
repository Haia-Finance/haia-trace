/**
 * The webhook request pipeline — the framework-agnostic composition of this
 * package's pieces: verify → parse → dedupe → normalize → record. The handler
 * owns the ORDER and the HTTP DECISION; what the pieces do is defined where
 * they live.
 *
 * The decision contract (`HandleResult.status`) encodes the delivery semantics
 * of an at-least-once webhook source:
 * - 400 — the request is not a valid Circle notification (bad signature,
 *   malformed envelope). A retry cannot fix it, so retrying must not be invited.
 * - 500 — WE failed (key resolution, persistence). Circle retries on non-2xx,
 *   which is exactly what should happen.
 * - 200 — accepted, including retries of already-accepted deliveries.
 *
 * This is a deliberate inversion of the in-process adapters' fail-open
 * discipline: there, a capture failure must never break the payment path, so
 * sinks swallow errors. Here, swallowing a persistence error and answering 200
 * would stop Circle's retries and lose the event forever. The `write` option
 * must therefore THROW on failure — with core's file sink, that is
 * `createFileWriter(path, (err) => { throw err; })`, which turns its fail-open
 * error routing into the fail-loud behavior this pipeline needs.
 *
 * Verification runs BEFORE parsing: nothing about an unauthenticated body is
 * trusted, not even that it is JSON. One handler serves any number of paths —
 * Circle requires a unique URL per subscription, but the source of a delivery
 * is identified by `notification_type`, not by which URL it arrived on.
 */

import {
  createRecorder,
  type EventInput,
  type TraceEvent,
} from "@usehaia/trace-core";

import { createMemoryDedupeStore, type DedupeStore } from "./dedupe.js";
import {
  type NotificationEnvelope,
  parseNotificationEnvelope,
} from "./envelope.js";
import { normalizeNotification } from "./normalize.js";
import type { NotificationVerifier } from "./verify.js";

/** Header names Circle signs deliveries with, lowercase. */
export const SIGNATURE_HEADER = "x-circle-signature";
export const KEY_ID_HEADER = "x-circle-key-id";

/** The adapter id stamped on every event this package records. */
export const ADAPTER_ID = "trace-circle";

/**
 * Where request headers come from — either a fetch-style `Headers` object or a
 * Node-style plain record (whose keys may arrive in any case). Kept structural
 * so the handler embeds in any server without importing its types.
 */
export type HeaderBag =
  | { get(name: string): string | null }
  | Record<string, string | readonly string[] | undefined>;

/** Case-insensitive single-value header lookup across both `HeaderBag` shapes. */
function headerValue(headers: HeaderBag, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const record = headers as Record<
    string,
    string | readonly string[] | undefined
  >;
  const lower = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== lower) continue;
    const value = record[key];
    if (typeof value === "string") return value;
    // A repeated signature header is ambiguous; take the first value the same
    // way a fetch Headers.get would.
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    return null;
  }
  return null;
}

/**
 * Map one verified envelope to the adapter's event inputs. Injected because the
 * event vocabulary belongs to the mapping, not to the pipeline — the pipeline
 * is finished while the vocabulary can still evolve. Return an empty list to
 * acknowledge a notification type without recording anything.
 */
export type NormalizeNotification = (
  envelope: NotificationEnvelope,
) => EventInput[];

/** What the embedding server should answer, plus why — one honest record per request. */
export type HandleResult =
  | {
      /** Accepted and recorded (or deliberately ignored by `normalize`). */
      status: 200;
      outcome: "recorded";
      envelope: NotificationEnvelope;
      /** The stamped events, exactly as written — for logging or inspection. */
      events: TraceEvent[];
    }
  | {
      /** A retry of an already-accepted delivery; nothing written again. */
      status: 200;
      outcome: "duplicate";
      envelope: NotificationEnvelope;
    }
  | {
      /** Not a valid Circle notification; a retry cannot fix it. */
      status: 400;
      outcome: "missing_signature" | "invalid_signature" | "invalid_envelope";
      reason: string;
    }
  | {
      /** Our side failed; Circle should retry. */
      status: 500;
      outcome: "key_resolution_failed" | "record_failed";
      reason: string;
    };

export interface WebhookHandlerOptions {
  /** Verifies `X-Circle-Signature` against the raw body; see `createVerifier`. */
  verifier: NotificationVerifier;
  /** The envelope → event-inputs mapping; defaults to the package's
   *  `normalizeNotification` (`circle.*` vocabulary). */
  normalize?: NormalizeNotification;
  /**
   * Persist one stamped event. MUST throw on failure — the handler answers 500
   * so Circle retries — never swallow (see the module comment for the
   * `createFileWriter` recipe).
   */
  write: (event: TraceEvent) => void;
  /** Deduplication backing; defaults to the bounded in-memory store. */
  dedupe?: DedupeStore;
  /** Injectable clock/id source, passed to the recorder for deterministic tests. */
  now?: () => string;
  newId?: () => string;
}

export interface WebhookHandler {
  /**
   * Process one delivery: `rawBody` exactly as received (signature verification
   * depends on the bytes), `headers` from the surrounding server.
   */
  handle(
    rawBody: string | Uint8Array,
    headers: HeaderBag,
  ): Promise<HandleResult>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Create a handler bound to one verifier, mapping, and sink. One handler is one
 * capture session: it owns the recorder (and thus the `seq` counter), so all
 * paths served by it write into one consistently-ordered stream.
 */
export function createWebhookHandler(
  options: WebhookHandlerOptions,
): WebhookHandler {
  const { verifier, write } = options;
  const normalize = options.normalize ?? normalizeNotification;
  const dedupe = options.dedupe ?? createMemoryDedupeStore();
  const recorder = createRecorder({
    adapter: ADAPTER_ID,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.newId !== undefined ? { newId: options.newId } : {}),
  });
  // One attestation per capture session, emitted alongside the first verified
  // delivery — "no events in the sink" must never be mistakable for "the
  // webhook receiver was never wired up" (the same honesty rule the x402
  // adapter's trace.attached serves). Context-less by design: it attests the
  // session, not any one operation.
  let attested = false;

  return {
    async handle(rawBody, headers) {
      const signature = headerValue(headers, SIGNATURE_HEADER);
      const keyId = headerValue(headers, KEY_ID_HEADER);
      if (signature === null || keyId === null) {
        return {
          status: 400,
          outcome: "missing_signature",
          reason: `missing ${SIGNATURE_HEADER} or ${KEY_ID_HEADER} header`,
        };
      }

      let verified: boolean;
      try {
        verified = await verifier.verify(rawBody, signature, keyId);
      } catch (err) {
        // The verifier throws only for infrastructure failures (key resolver);
        // an invalid signature is a `false`, handled below.
        return {
          status: 500,
          outcome: "key_resolution_failed",
          reason: message(err),
        };
      }
      if (!verified) {
        return {
          status: 400,
          outcome: "invalid_signature",
          reason: "signature does not match the request body",
        };
      }

      let envelope: NotificationEnvelope;
      try {
        envelope = parseNotificationEnvelope(rawBody);
      } catch (err) {
        return {
          status: 400,
          outcome: "invalid_envelope",
          reason: message(err),
        };
      }

      if (!dedupe.firstSeen(envelope.notification_id)) {
        return { status: 200, outcome: "duplicate", envelope };
      }

      try {
        const events: TraceEvent[] = [];
        if (!attested) {
          const attestation = recorder.event({
            event_type: "trace.attached",
            payload: { source: "circle-webhook" },
          });
          write(attestation);
          // Only after the write survives: a failed write leaves the session
          // unattested so the next delivery attests again.
          attested = true;
          events.push(attestation);
        }
        for (const input of normalize(envelope)) {
          const event = recorder.event(input);
          write(event);
          events.push(event);
        }
        return { status: 200, outcome: "recorded", envelope, events };
      } catch (err) {
        // The claim must not outlive the failure: un-record the id so Circle's
        // retry is processed as a fresh delivery instead of a duplicate.
        dedupe.forget(envelope.notification_id);
        return { status: 500, outcome: "record_failed", reason: message(err) };
      }
    },
  };
}
