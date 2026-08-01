/**
 * `trace()` — the entry point, and the four questions it answers before handing
 * off: is capture switched off, is this an instance at all, has it been traced
 * already, and which kind is it.
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
   * Where recorded events go. Default: NDJSON on stdout. Pass
   * `createRunEventWriter(".trace/events")` from `@usehaia/trace-core/file` to
   * persist a run. The writer's lifetime is the caller's — `trace()` never
   * closes it.
   */
  writer?: EventWriter;
  /**
   * Recorder that stamps `event_id` / `occurred_at` / `seq`. Defaults to a
   * process-wide one, so several traced instances share one ordered session.
   */
  recorder?: EventRecorder;
  /** Observe recorder-internal errors (e.g. a throwing writer). */
  onError?: (err: unknown) => void;
  /**
   * Force the instance kind instead of inferring it. An unrecognized value is
   * ignored, and it only takes effect on the first `trace()` for an instance.
   */
  kind?: TraceInstanceKind;
}

/**
 * Attach the recorder to an x402 v2 instance and record a TraceEvent on every
 * lifecycle hook, tagged with the observing role and the operation it belongs
 * to. Idempotent per instance; a no-op when `HAIA_TRACE_DISABLE=1`.
 */
export function trace(
  instance: unknown,
  options: TraceOptions = {},
): TraceAttestation {
  if (isDisabled()) return inertAttestation();
  // Accept callable objects too — an instance may be a function with hook
  // methods hanging off it.
  if (
    instance === null ||
    (typeof instance !== "object" && typeof instance !== "function")
  ) {
    return inertAttestation();
  }

  const target = instance as Record<string, unknown>;

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
