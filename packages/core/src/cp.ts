/**
 * The Haia Control Plane sink — an `EventWriter` that mirrors TraceEvents to a
 * Control Plane project over its ingest API, exposed at the
 * `@usehaia/trace-core/cp` subpath.
 *
 * It is a *mirror*, not a replacement: the local run file stays the source of
 * truth the assembler reads, and a producer that wants both wraps the two
 * writers with `createMulticastWriter`. Nothing here reads back — a receipt is
 * assembled from local events, and the Control Plane dashboard is where the
 * uploaded copy is looked at.
 *
 * Like every sink, it is fail-open: a payment path must not break because an
 * upload did. `write` buffers and returns immediately, faults are routed to
 * `onError`, and events are dropped rather than retried forever. What it does
 * *not* do is pretend — a dropped batch and a rejected event are both reported,
 * so "the Control Plane has nothing" is never quietly forged from a failure.
 *
 * Delivery is batched, because the batch endpoint answers synchronously with a
 * per-event verdict; the single-event endpoint acknowledges before it stores,
 * which would leave a caller unable to tell an accepted event from a lost one.
 *
 * This module reaches the network through `fetch` and the timer globals only,
 * so it stays runtime-agnostic — Node, edge, and browser alike — and adds no
 * dependency. Both are read off `globalThis` behind local structural types, the
 * same way `recorder.ts` reads `crypto.randomUUID`, so core needs neither DOM
 * nor Node ambient types.
 */

import type { TraceEvent } from "./event.js";
import type { EventWriter, SinkErrorHandler } from "./sink.js";

/** Path of the ingest batch endpoint, appended to the configured base URL. */
const BATCH_PATH = "/v1/events:batch";
/** Header the ingest API reads the project's publishable ingest token from. */
const API_KEY_HEADER = "x-haia-api-key";
/** Stamped on every event's `meta`, so uploaded rows can be told from an SDK's. */
const SOURCE = "haia-trace";
/** Names the shape `properties` was built from, for a later change to migrate against. */
const TRACE_SCHEMA = "v1";

/** The ingest API's own per-request cap; a larger batch is rejected outright. */
const MAX_BATCH = 500;
/** Bounds the ingest API validates the envelope against, mirrored here — see `mapEvent`. */
const MAX_EVENT_TYPE = 128;
const MAX_CLIENT_EVENT_ID = 128;
const MAX_IDENTITY = 256;
/** The character set the ingest API accepts in an `event_type`. */
const EVENT_TYPE_PATTERN = /^[\w$\-. ]+$/;

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
const DEFAULT_MAX_QUEUE = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 10_000;
/** First backoff step; each further attempt doubles it. */
const RETRY_BASE_MS = 500;

// ── Platform surface ────────────────────────────────────────────────────────
//
// Local structural views of the globals this module uses. They describe only
// what is called here, so any runtime providing a compatible `fetch` — including
// a stub in a test — satisfies them.

/** The subset of a `fetch` response this module reads. */
export interface CpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  readonly headers?: { get(name: string): string | null };
}

/** The `fetch` shape this module calls; injectable so tests never touch a network. */
export type CpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: unknown;
  },
) => Promise<CpResponse>;

interface Platform {
  fetch?: CpFetch;
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  AbortSignal?: { timeout?: (ms: number) => unknown };
}

const platform = globalThis as unknown as Platform;

/**
 * Stop a pending timer from holding a Node process open. `unref` exists on
 * Node's timer handle and not in other runtimes, so it is called when present —
 * capture must never be the reason a finished program keeps running.
 */
function unref(handle: unknown): void {
  (handle as { unref?: () => void } | undefined)?.unref?.();
}

// ── Wire shape ──────────────────────────────────────────────────────────────

/**
 * One event in the ingest API's native wire format.
 *
 * The envelope is closed — the API rejects a request carrying any key it does
 * not know — so this interface is exhaustive by design, and a field is omitted
 * rather than sent as `null` when absent.
 */
export interface IngestEvent {
  event_type: string;
  occurred_at: string;
  client_event_id?: string;
  anonymous_id?: string;
  user_id?: string;
  session_id?: string;
  properties: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/** One event the ingest API refused to store, as reported in the batch response. */
export interface IngestRejection {
  /** Position in the submitted batch. */
  index: number;
  issues: { code: string; field?: string | null; message?: string | null }[];
}

/** The batch endpoint's response body. */
export interface IngestBatchResult {
  accepted: number;
  /** Events already stored under the same `client_event_id`; a safe retry, not a fault. */
  duplicates: number;
  rejections: IngestRejection[];
}

/** Who the uploaded events belong to; the ingest API requires an identity on each one. */
export interface CpIdentity {
  /**
   * Identity of the agent or service the run belongs to. Sent as `anonymous_id`
   * — the Control Plane's identity for a subject that is not a signed-in person,
   * which is what an autonomous payer is.
   */
  agentId?: string;
  /** Sent as `user_id`, when the run is attributable to a person. */
  userId?: string;
  /**
   * The local run these events came from — one start of the recording service.
   * Recorded in `meta`, not sent as `session_id`: a run is the *file* the events
   * were written to, which can hold many unrelated operations.
   */
  runId?: string;
}

/**
 * Map one TraceEvent onto the ingest envelope.
 *
 * `context_id` becomes `session_id`. Both name the same thing on their own side
 * — one logical operation, the events of a single payment — so an operation is
 * what the Control Plane groups by, which is the unit a receipt is assembled for
 * too. The run id is deliberately *not* what is sent here: a run is one start of
 * the recording service and can span many unrelated operations, so grouping by
 * it would merge payments that have nothing to do with each other. It travels in
 * `meta` instead, where it says which capture the row came from. An event
 * without a request context — a chain confirmation, an attestation — simply
 * carries no `session_id`.
 *
 * The split between the two free-form objects follows what each is for:
 * `properties` carries what an analysis would group or filter by — the event's
 * own payload, plus the envelope fields that are dimensions of it (`role`,
 * `context_id`, `seq`, `adapter`) — while `meta` carries provenance about the
 * upload itself. The envelope fields are spread *after* the payload so a payload
 * key can never displace one of them.
 *
 * `event_id` becomes `client_event_id`, which the ingest API deduplicates on:
 * re-sending a batch after an ambiguous failure stores nothing twice. A custom
 * recorder may mint an id longer than the API accepts, in which case the field
 * is left off — the event still lands, it just loses that protection.
 */
export function toIngestEvent(
  event: TraceEvent,
  identity: CpIdentity = {},
): IngestEvent {
  const properties: Record<string, unknown> = {
    ...event.payload,
    seq: event.seq,
    adapter: event.adapter,
    ...(event.role !== undefined ? { role: event.role } : {}),
    // Also a property, not only `session_id`: the operation is the dimension an
    // analysis reaches for most, and a property is filterable wherever a
    // free-form key is, which is not yet true of every read surface.
    ...(event.context_id !== undefined ? { context_id: event.context_id } : {}),
  };

  return {
    event_type: event.event_type,
    occurred_at: event.occurred_at,
    ...(event.event_id.length <= MAX_CLIENT_EVENT_ID
      ? { client_event_id: event.event_id }
      : {}),
    ...(identity.agentId !== undefined
      ? { anonymous_id: identity.agentId }
      : {}),
    ...(identity.userId !== undefined ? { user_id: identity.userId } : {}),
    // A `context_id` is an adapter's own string and has no length rule of its
    // own, so one longer than the API's column is left off rather than allowed
    // to fail the request: losing the grouping costs less than losing the event.
    // It stays in `properties` either way.
    ...(event.context_id !== undefined &&
    event.context_id.length <= MAX_IDENTITY
      ? { session_id: event.context_id }
      : {}),
    properties,
    meta: {
      source: SOURCE,
      trace_schema: TRACE_SCHEMA,
      ...(identity.runId !== undefined ? { run_id: identity.runId } : {}),
    },
  };
}

/**
 * Why an event cannot be sent, or `null` when it can.
 *
 * The check exists because the ingest API validates the envelope for the whole
 * request at once: one event whose `event_type` breaks the accepted character
 * set fails the entire batch, taking hundreds of good events with it. Screening
 * such an event out here costs it alone, and the caller hears about it.
 */
function unsendableReason(event: IngestEvent): string | null {
  const type = event.event_type;
  if (type.length === 0 || type.length > MAX_EVENT_TYPE) {
    return `event_type must be 1..${MAX_EVENT_TYPE} characters`;
  }
  if (!EVENT_TYPE_PATTERN.test(type)) {
    return "event_type may only contain word characters, '$', '-', '.' and spaces";
  }
  if (event.anonymous_id === undefined && event.user_id === undefined) {
    return "an event needs an identity: configure agentId or userId";
  }
  return null;
}

// ── Writer ──────────────────────────────────────────────────────────────────

export interface CpWriterOptions extends CpIdentity {
  /**
   * Base URL of the Control Plane ingest service, e.g.
   * `https://ingest.example.com`. The batch endpoint's path is appended, so a
   * trailing slash is harmless.
   */
  url: string;
  /** The project's publishable ingest token. */
  apiKey: string;
  /** Events per request. Clamped to the API's cap of 500. Default 100. */
  batchSize?: number;
  /**
   * How long a partly-filled batch waits before going out anyway. Default 2s —
   * an interval, not a promise of latency: a run that ends sooner should be
   * flushed explicitly.
   */
  flushIntervalMs?: number;
  /**
   * Ceiling on events held while delivery is failing or slow. Default 10 000.
   * Past it new events are dropped, and each drop is reported — a bounded queue
   * that says what it lost beats an unbounded one that exhausts the process.
   */
  maxQueue?: number;
  /** Retries after a failed attempt, for faults worth retrying. Default 2. */
  maxRetries?: number;
  /** Per-request timeout, when the runtime can express one. Default 10s. */
  timeoutMs?: number;
  /** The `fetch` to send with. Defaults to the runtime's global. */
  fetch?: CpFetch;
  /** Where delivery faults and rejected events are reported. */
  onError?: SinkErrorHandler;
}

/** A Control Plane writer; `flush` is always present here, unlike on the base contract. */
export interface CpWriter extends EventWriter {
  flush(): Promise<void>;
}

/**
 * Open a writer that uploads events to a Control Plane project.
 *
 * `write` maps and queues the event and returns; delivery happens in batches,
 * when one fills up or the flush interval elapses. `flush` settles what has been
 * queued so far and never rejects. `close` stops the timer and starts a final
 * delivery, but a caller that needs the events to have *arrived* — a process
 * about to exit — should `await writer.flush()` first.
 *
 * Configuration is validated eagerly and throws: a mistyped URL or an
 * over-long agent id is a wiring bug in the caller's setup, and failing at
 * construction is honest, where failing per-event would be noise. Everything
 * after construction is fail-open.
 */
export function createCpWriter(options: CpWriterOptions): CpWriter {
  const endpoint = `${options.url.replace(/\/+$/, "")}${BATCH_PATH}`;
  const identity: CpIdentity = {
    agentId: options.agentId,
    userId: options.userId,
    runId: options.runId,
  };
  assertConfig(options, identity);

  const batchSize = Math.min(
    Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE),
    MAX_BATCH,
  );
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onError = options.onError;

  const report = (err: unknown): void => {
    try {
      onError?.(err);
    } catch {
      /* a throwing error handler must not become the failure it reports */
    }
  };

  const queue: IngestEvent[] = [];
  let timer: unknown = null;
  let closed = false;
  // Deliveries are chained rather than run concurrently, so batches reach the
  // Control Plane in the order they were queued and a flush awaits the sends
  // that were already under way.
  let inFlight: Promise<void> = Promise.resolve();

  const clearTimer = (): void => {
    if (timer !== null) {
      platform.clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleFlush = (): void => {
    if (timer !== null || closed) return;
    timer = platform.setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
    unref(timer);
  };

  /** Send one batch, retrying the faults that a retry can fix. */
  const deliver = async (batch: IngestEvent[]): Promise<void> => {
    const send = options.fetch ?? platform.fetch;
    if (send === undefined) {
      report(
        new Error(
          `haia-cp: no fetch available in this runtime; dropped ${batch.length} event(s)`,
        ),
      );
      return;
    }

    const signal = timeout(timeoutMs);

    for (let attempt = 0; ; attempt++) {
      let retryAfterMs: number | undefined;
      let fault: unknown;
      try {
        const response = await send(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [API_KEY_HEADER]: options.apiKey,
          },
          body: JSON.stringify({ events: batch }),
          ...(signal !== undefined ? { signal } : {}),
        });

        if (response.ok) {
          reportRejections(await readResult(response), batch, report);
          return;
        }
        // A 4xx that is not rate limiting is the caller's configuration — a bad
        // token, a project that does not exist. Retrying re-sends a request that
        // will fail identically, so the batch is dropped and reported instead.
        if (response.status !== 429 && response.status < 500) {
          report(
            new Error(
              `haia-cp: ingest answered ${response.status}; dropped ${batch.length} event(s)`,
            ),
          );
          return;
        }
        // Rate limiting or a server fault: the same request may well succeed later.
        retryAfterMs = retryAfter(response);
        fault = new Error(`haia-cp: ingest answered ${response.status}`);
      } catch (err) {
        // A transport fault — unreachable host, timeout. Worth another attempt.
        fault = err;
      }

      if (attempt >= maxRetries) {
        report(fault);
        report(
          new Error(
            `haia-cp: dropped ${batch.length} event(s) after ${attempt + 1} attempt(s)`,
          ),
        );
        return;
      }
      await sleep(retryAfterMs ?? RETRY_BASE_MS * 2 ** attempt);
    }
  };

  const flush = async (): Promise<void> => {
    clearTimer();
    if (queue.length === 0) {
      // Still awaits a delivery already under way, so `flush` means "settled"
      // even when this call has nothing of its own to send.
      await inFlight;
      return;
    }

    const batches: IngestEvent[][] = [];
    while (queue.length > 0) batches.push(queue.splice(0, batchSize));

    inFlight = inFlight
      .then(async () => {
        for (const batch of batches) await deliver(batch);
      })
      // Guards the chain itself: were a delivery ever to reject, an unguarded
      // `inFlight` would stay rejected and fail every later flush.
      .catch(report);
    await inFlight;
  };

  return {
    write(event: TraceEvent): void {
      if (closed) {
        report(new Error("haia-cp: writer is closed; dropped 1 event"));
        return;
      }

      const mapped = toIngestEvent(event, identity);
      const reason = unsendableReason(mapped);
      if (reason !== null) {
        // Screened out alone rather than allowed to fail the batch it rides in.
        report(
          new Error(
            `haia-cp: cannot send event ${event.event_id} (${event.event_type}): ${reason}`,
          ),
        );
        return;
      }

      if (queue.length >= maxQueue) {
        report(
          new Error(
            `haia-cp: queue is full at ${maxQueue} events; dropped 1 event`,
          ),
        );
        return;
      }

      queue.push(mapped);
      if (queue.length >= batchSize) {
        void flush();
      } else {
        scheduleFlush();
      }
    },

    flush,

    close(): void {
      if (closed) return;
      closed = true;
      clearTimer();
      // Start the last delivery but do not block: `close` is synchronous by
      // contract. A caller that needs the events delivered awaits `flush` first.
      void flush();
    },
  };
}

/** Reject a configuration the ingest API would refuse, at the point it is set. */
function assertConfig(options: CpWriterOptions, identity: CpIdentity): void {
  if (!/^https?:\/\//.test(options.url)) {
    throw new Error(
      `haia-cp: url must be an http(s) URL, got "${options.url}"`,
    );
  }
  if (options.apiKey === "") {
    throw new Error("haia-cp: apiKey is required");
  }
  if (identity.agentId === undefined && identity.userId === undefined) {
    throw new Error(
      "haia-cp: an identity is required — pass agentId (or userId)",
    );
  }
  // Only the two identity fields are bounded here: `runId` travels in the
  // free-form `meta`, which has no per-key rule to break.
  for (const name of ["agentId", "userId"] as const) {
    const value = identity[name];
    if (value !== undefined && value.length > MAX_IDENTITY) {
      throw new Error(
        `haia-cp: ${name} must be at most ${MAX_IDENTITY} characters`,
      );
    }
  }
}

/** A per-request timeout signal, when the runtime offers one. */
function timeout(ms: number): unknown {
  return platform.AbortSignal?.timeout?.(ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    unref(platform.setTimeout(resolve, ms));
  });
}

/**
 * How long the service asked us to wait, from a `Retry-After` header in
 * seconds. Honouring it is what keeps a rate-limited client from making the
 * congestion it ran into worse.
 */
function retryAfter(response: CpResponse): number | undefined {
  const header = response.headers?.get("retry-after");
  if (header === undefined || header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Read the batch verdict, tolerating a body that is not the JSON we expect. */
async function readResult(
  response: CpResponse,
): Promise<IngestBatchResult | null> {
  try {
    return JSON.parse(await response.text()) as IngestBatchResult;
  } catch {
    // A 2xx we cannot parse means the events were accepted by an endpoint that
    // answers differently than we read. Nothing is lost, so nothing is reported.
    return null;
  }
}

/**
 * Surface the events the Control Plane stored nothing for. Duplicates are not
 * among them: those are the deduplication working, not a loss.
 */
function reportRejections(
  result: IngestBatchResult | null,
  batch: IngestEvent[],
  report: (err: unknown) => void,
): void {
  const rejections = result?.rejections ?? [];
  if (rejections.length === 0) return;

  const detail = rejections
    .map((rejection) => {
      const event = batch[rejection.index];
      const codes = rejection.issues.map((issue) => issue.code).join(", ");
      return `${event?.event_type ?? `#${rejection.index}`}: ${codes}`;
    })
    .join("; ");
  report(
    new Error(
      `haia-cp: rejected ${rejections.length} of ${batch.length} event(s) — ${detail}`,
    ),
  );
}
