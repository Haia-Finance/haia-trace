/**
 * `@usehaia/trace-x402` — passive recorder over the x402 v2 lifecycle hooks.
 * Hooks reference: https://docs.x402.org/advanced-concepts/lifecycle-hooks
 *
 * `trace(instance)` resolves the instance's kind (client, resource server,
 * facilitator, …), duck-typing-attaches to that kind's lifecycle hooks, and turns
 * every firing into an Event Contract `TraceEvent`: an allowlisted payload
 * (`events.ts` / `normalize.ts`), the observing `role` fixed by the kind, and the
 * `context_id` that groups one request's events (`correlate.ts`). Events are
 * stamped by a `@usehaia/trace-core` recorder and handed to an `EventWriter`.
 *
 * Strictly passive — the load-bearing invariant. x402 lifecycle hooks can steer
 * the payment flow through their return value (`{ abort }`, `{ skip }`,
 * `{ recovered }`, …). Every handler here is wrapped in try/catch and ALWAYS
 * returns `undefined`, so the recorder can observe a payment but never alter it.
 */

import {
  createRecorder,
  type EventRecorder,
  type EventWriter,
  encodeEventLine,
} from "@usehaia/trace-core";

import { type Correlator, createCorrelator } from "./correlate.js";
import { HOOK_EVENTS, type HookEvent } from "./events.js";
import {
  HOOKS_BY_KIND,
  type HookContextMap,
  KNOWN_INSTANCE_KINDS,
  ROLE_BY_KIND,
  resolveKind,
  type TraceInstanceKind,
  type TraceKind,
  type TraceRole,
} from "./hooks.js";

export type { TraceInstanceKind, TraceKind, TraceRole } from "./hooks.js";

/** Id stamped on every event this package produces. */
const ADAPTER = "trace-x402";

export interface TraceOptions {
  /**
   * Where recorded events go. Default: one NDJSON line per event on stdout —
   * the same encoding the file sink uses, so it can be piped straight into a run
   * file. Pass `createRunWriter({ dir: ".trace/events" })` from
   * `@usehaia/trace-core/node` to persist a run. The writer's lifetime is the
   * caller's: `trace()` never closes it.
   */
  writer?: EventWriter;
  /**
   * Recorder that stamps `event_id` / `occurred_at` / `seq`. Defaults to a
   * process-wide one, so several traced instances share a single ordered
   * session. Pass your own to inject a clock and id source in tests.
   */
  recorder?: EventRecorder;
  /** Observe recorder-internal errors (e.g. a throwing writer). */
  onError?: (err: unknown) => void;
  /** Force the instance kind instead of inferring it from the method set. An
   *  unrecognized value is ignored (inference is used instead), and it only
   *  takes effect on the first `trace()` for a given instance — a repeat call is
   *  a no-op that returns the original attestation. */
  kind?: TraceInstanceKind;
}

/**
 * What `trace()` connected to. Reporting this — rather than failing silently —
 * lets a caller tell "no payment events happened" apart from "the recorder never
 * wired up to this instance".
 */
export interface TraceAttestation {
  /** Hook methods that actually registered on the instance. */
  attached: string[];
  /** `attached.length > 0` — false means capture did not connect. */
  ok: boolean;
  /** The resolved (or overridden) instance kind. */
  kind: TraceKind;
  /** The observing role implied by `kind`. */
  role: TraceRole;
}

/**
 * Instances we have already attached to, mapped to the attestation from that
 * first attach so a repeat `trace()` returns it unchanged. A WeakMap (not a
 * property marker) is used deliberately: it never mutates the target, so
 * idempotency holds even for a frozen/sealed instance.
 */
const traced = new WeakMap<object, TraceAttestation>();

// The process-wide session. Both are shared across `trace()` calls on purpose:
// one recorder gives every instance a single `seq` sequence, and one correlator
// lets a client and a server traced in the same process resolve the same payment
// to the same `context_id`.
let sharedRecorder: EventRecorder | undefined;
let sharedCorrelator: Correlator | undefined;

/** Drop the process-wide recorder and correlator. Intended for test isolation. */
export function resetTraceSession(): void {
  sharedRecorder = undefined;
  sharedCorrelator = undefined;
}

function consoleWriter(): EventWriter {
  return {
    write(event): void {
      console.log(encodeEventLine(event));
    },
    close(): void {
      /* stdout is not ours to close */
    },
  };
}

function isDisabled(): boolean {
  // `process` may be absent in browser/edge runtimes (where HTTP clients run);
  // reading it unguarded would throw ReferenceError straight out of trace().
  return (
    typeof process !== "undefined" && process.env.HAIA_TRACE_DISABLE === "1"
  );
}

/** An attestation for a run that never wired up (disabled, or non-instance input). */
function inertAttestation(): TraceAttestation {
  return { attached: [], ok: false, kind: "unknown", role: "unknown" };
}

/**
 * Attach the recorder to an x402 v2 instance and record a TraceEvent on every
 * lifecycle hook, tagged with the observing role and the operation it belongs to.
 *
 * Passive by construction: registered handlers only record and always return
 * `undefined`, so multi-registration alongside the user's own hooks never changes
 * the payment outcome. Idempotent per instance; a no-op when `HAIA_TRACE_DISABLE=1`.
 */
export function trace(
  instance: unknown,
  options: TraceOptions = {},
): TraceAttestation {
  const onError = options.onError;

  if (isDisabled()) return inertAttestation();
  // Accept objects and callable objects (an instance may be a function with hook
  // methods hanging off it); reject only null/undefined and primitives.
  if (
    instance === null ||
    (typeof instance !== "object" && typeof instance !== "function")
  ) {
    return inertAttestation();
  }

  const target = instance as Record<string, unknown>;

  // Idempotency: a second trace() re-registers nothing and returns the first result.
  const existing = traced.get(target);
  if (existing) return existing;

  const writer = options.writer ?? consoleWriter();
  sharedRecorder ??= createRecorder({ adapter: ADAPTER });
  sharedCorrelator ??= createCorrelator();
  const recorder = options.recorder ?? sharedRecorder;
  const correlator = sharedCorrelator;

  // Surface a recorder error without ever letting it — or a throwing onError —
  // reach the payment path.
  const reportError = (err: unknown): void => {
    try {
      onError?.(err);
    } catch {
      /* onError itself must not break the flow */
    }
  };

  const record = (
    event_type: string,
    payload: Record<string, unknown>,
    role: TraceRole,
    context_id?: string,
  ): void => {
    try {
      writer.write(
        recorder.event({
          event_type,
          payload,
          role,
          ...(context_id !== undefined ? { context_id } : {}),
        }),
      );
    } catch (err) {
      reportError(err);
    }
  };

  // Resolve the kind once; it fixes the role for every hook and selects which
  // hook group to register. An explicit, recognized `kind` wins over inference.
  // An unrecognized override (a plain-JS caller, or a prototype key such as
  // "constructor") is ignored in favor of inference rather than indexing into an
  // `undefined` group and throwing — trace() must never break the caller it
  // wraps. A resolved "unknown" means no recognized hook is present, so there is
  // nothing to attach and the run reports `trace.attach_failed` below.
  const override = options.kind;
  const kind: TraceKind =
    override !== undefined && KNOWN_INSTANCE_KINDS.has(override)
      ? override
      : resolveKind(target);
  const role = ROLE_BY_KIND[kind];
  const methods: readonly (keyof HookContextMap)[] =
    kind === "unknown" ? [] : HOOKS_BY_KIND[kind];

  const attached: string[] = [];

  // Generic over the hook name, so each mapper gets the context its hook is
  // actually handed. `role` is fixed for this instance.
  const makeHandler =
    <K extends keyof HookContextMap>(hook: K) =>
    (context: HookContextMap[K]): undefined => {
      try {
        const mapped: HookEvent = HOOK_EVENTS[hook](context);
        const contextId = correlator.resolve(mapped);
        record(mapped.event_type, mapped.payload, role, contextId);
      } catch (err) {
        reportError(err);
      }
      return undefined;
    };

  for (const name of methods) {
    const register = target[name];
    if (typeof register === "function") {
      try {
        // The typed handler is registered through an `unknown`-context slot;
        // widening the parameter is safe because the SDK only ever calls it with
        // that hook's real context.
        const handler = makeHandler(name) as (context: unknown) => undefined;
        // x402 hooks are chainable and support multiple registrations, so
        // adding our handler runs alongside — never displaces — the user's hooks.
        (
          register as (handler: (context: unknown) => undefined) => unknown
        ).call(target, handler);
        attached.push(name);
      } catch (err) {
        reportError(err);
      }
    }
  }

  // Record the attestation either way, so a failed attach is never mistaken for a
  // quiet run that simply saw no payment activity. It belongs to no operation, so
  // it carries no `context_id` and the assembler keeps it out of every receipt.
  record(
    attached.length > 0 ? "trace.attached" : "trace.attach_failed",
    { kind, attached },
    role,
  );

  const result: TraceAttestation = {
    attached,
    ok: attached.length > 0,
    kind,
    role,
  };
  traced.set(target, result);
  return result;
}
