/**
 * `trace()` — the package's one entry point, and the four decisions it makes
 * before handing off: is capture switched off, is this an instance at all, has
 * it been traced already, and which kind is it.
 */

import type { EventRecorder, EventWriter } from "@usehaia/trace-core";

import {
  attach,
  attestationOf,
  inertAttestation,
  type TraceAttestation,
} from "./attach.js";
import { resolveKind } from "./registry.js";
import { consoleWriter, isDisabled, openSession } from "./session.js";
import type { TraceInstanceKind } from "./spec.js";

export interface TraceOptions {
  /**
   * Where recorded events go. Default: one NDJSON line per event on stdout —
   * the same encoding the file sink uses, so it can be piped straight into a run
   * file. Pass `createRunWriter(".trace/events")` from
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
  const existing = attestationOf(target);
  if (existing !== undefined) return existing;

  const { recorder, correlator } = openSession(options.recorder);

  return attach(target, resolveKind(target, options.kind), {
    writer: options.writer ?? consoleWriter(),
    recorder,
    correlator,
    onError: options.onError,
  });
}
