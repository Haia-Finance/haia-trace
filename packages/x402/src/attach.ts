/**
 * Registering the recorder on an instance, and reporting honestly what that
 * connected to.
 *
 * Every handler registered here is wrapped in try/catch and always returns
 * `undefined` — the passivity invariant. x402 hooks read a handler's return
 * value as a command, so anything else would let the recorder steer a payment.
 */

import type { EventRecorder, EventWriter } from "@usehaia/trace-core";

import type { Correlator } from "./correlate.js";
import { SPECS } from "./registry.js";
import type { ErasedSpec, HookEvent, TraceKind, TraceRole } from "./spec.js";

/**
 * What `trace()` connected to — so a caller can tell "no payment events
 * happened" apart from "the recorder never wired up", and from "it wired up to
 * only part of this instance".
 */
export interface TraceAttestation {
  /** Hooks that registered, in registration order. One found on a wrapped instance is labelled by where it registered, e.g. `server.onBeforeVerify`. */
  attached: string[];
  /** Hooks of this kind that registered nowhere — the firings this run will be missing. */
  missing: string[];
  /** `attached.length > 0` — false means capture did not connect at all. */
  ok: boolean;
  /** `ok` and nothing missing — every hook of the kind is being observed. */
  complete: boolean;
  kind: TraceKind;
  role: TraceRole;
}

/** Where an attached handler sends what it observed, and what it groups it by. */
export interface CaptureIO {
  writer: EventWriter;
  recorder: EventRecorder;
  correlator: Correlator;
  /** Observe recorder-internal faults. Never reaches the payment path. */
  onError?: (err: unknown) => void;
}

// A WeakMap, not a property marker: it never mutates the target, so idempotency
// holds even for a frozen or sealed instance.
const traced = new WeakMap<object, TraceAttestation>();

/** The attestation from an earlier `trace()` of this instance, if there was one. */
export const attestationOf = (target: object): TraceAttestation | undefined =>
  traced.get(target);

/** An attestation for a run that never wired up — disabled, or non-instance input. */
export const inertAttestation = (): TraceAttestation => ({
  attached: [],
  missing: [],
  ok: false,
  complete: false,
  kind: "unknown",
  role: "unknown",
});

/**
 * The first candidate property that actually exposes one of `hooks`. Each read
 * is guarded: a getter is foreign code, and looking for the wrapped instance
 * must not be able to throw out of `trace()`.
 */
function findInner(
  target: Record<string, unknown>,
  props: readonly string[],
  hooks: readonly string[],
): { host: Record<string, unknown>; prop: string } | undefined {
  for (const prop of props) {
    let candidate: unknown;
    try {
      candidate = target[prop];
    } catch {
      continue;
    }
    if (
      candidate === null ||
      (typeof candidate !== "object" && typeof candidate !== "function")
    ) {
      continue;
    }
    const host = candidate as Record<string, unknown>;
    if (hooks.some((hook) => typeof host[hook] === "function")) {
      return { host, prop };
    }
  }
  return undefined;
}

const attestationEvent = (ok: boolean, complete: boolean): string =>
  !ok
    ? "trace.attach_failed"
    : complete
      ? "trace.attached"
      : "trace.attach_partial";

/**
 * Register the recorder on every hook of `kind` this instance exposes — and on
 * the instance it wraps, when the kind is a wrapper — then record and return the
 * attestation. A resolved `"unknown"` has nothing to attach and reports
 * `trace.attach_failed`.
 */
export function attach(
  target: Record<string, unknown>,
  kind: TraceKind,
  io: CaptureIO,
): TraceAttestation {
  const spec = kind === "unknown" ? undefined : SPECS[kind];
  const role: TraceRole = spec?.role ?? "unknown";

  const reportError = (err: unknown): void => {
    try {
      io.onError?.(err);
    } catch {
      /* onError itself must not break the flow */
    }
  };

  const record = (
    event_type: string,
    payload: Record<string, unknown>,
    context_id?: string,
  ): void => {
    try {
      io.writer.write(
        io.recorder.event({
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

  const attached: string[] = [];
  // Coverage is per hook name, not per location: a hook registered on the
  // wrapped instance covers the kind's expectation just as one on the instance.
  const covered = new Set<string>();

  const makeHandler =
    (hook: string, mapper: (context: never) => HookEvent) =>
    (context: unknown): undefined => {
      try {
        // The SDK only ever calls this with the context its hook is declared to
        // hand out — the one the mapper is typed against — so widening it back
        // is safe. The only place the spec's erased hook types are re-opened.
        const mapped = (mapper as (context: unknown) => HookEvent)(context);
        record(
          mapped.event_type,
          mapped.payload,
          io.correlator.resolve(mapped),
        );
      } catch (err) {
        reportError(err);
        // A firing that could not be mapped still leaves a line, so the gap is
        // visible in the run. No `context_id`: the keys are read by the mapper
        // that just failed, and guessing an operation is the dishonesty this
        // event exists to record.
        record("trace.capture_failed", { hook });
      }
      return undefined;
    };

  const attachGroup = (
    host: Record<string, unknown>,
    group: ErasedSpec,
    prefix: string,
  ): void => {
    for (const [name, mapper] of Object.entries(group.mappers)) {
      const register = host[name];
      if (typeof register !== "function") continue;
      try {
        // x402 hooks are chainable, so ours runs alongside — never displaces —
        // the user's own.
        (
          register as (handler: (context: unknown) => undefined) => unknown
        ).call(host, makeHandler(name, mapper));
        attached.push(`${prefix}${name}`);
        covered.add(name);
      } catch (err) {
        reportError(err);
      }
    }
  };

  if (spec !== undefined) attachGroup(target, spec, "");

  // Skipped when the wrapped instance was traced on its own, which would
  // otherwise register a second handler and double its events.
  let innerHost: Record<string, unknown> | undefined;
  if (spec?.inner !== undefined) {
    const innerSpec = SPECS[spec.inner.kind];
    const found = findInner(
      target,
      spec.inner.props,
      Object.keys(innerSpec.mappers),
    );
    if (found !== undefined && !traced.has(found.host)) {
      innerHost = found.host;
      attachGroup(found.host, innerSpec, `${found.prop}.`);
    }
  }

  const hooks = spec === undefined ? [] : Object.keys(spec.mappers);
  const missing = hooks.filter((name) => !covered.has(name));
  const ok = attached.length > 0;
  const complete = ok && missing.length === 0;

  // Recorded either way, so a failed or partial attach is never mistaken for a
  // quiet run. It belongs to no operation, so it carries no `context_id` and the
  // assembler keeps it out of every receipt.
  record(attestationEvent(ok, complete), {
    kind,
    attached,
    ...(missing.length > 0 ? { missing } : {}),
  });

  const attestation: TraceAttestation = {
    attached,
    missing,
    ok,
    complete,
    kind,
    role,
  };
  traced.set(target, attestation);
  // Mark the wrapped instance too, so a later `trace()` on it is the same no-op.
  if (innerHost !== undefined) traced.set(innerHost, attestation);
  return attestation;
}
