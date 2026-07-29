/**
 * The process-wide capture session and the defaults `trace()` falls back to.
 *
 * Both are shared across `trace()` calls on purpose: one recorder gives every
 * instance a single `seq` sequence, and one correlator lets a client and a
 * server traced in the same process resolve the same payment to the same
 * `context_id`.
 */

import {
  createRecorder,
  type EventRecorder,
  type EventWriter,
  encodeEventLine,
} from "@usehaia/trace-core";

import { type Correlator, createCorrelator } from "./correlate.js";

const ADAPTER = "trace-x402";

let sharedRecorder: EventRecorder | undefined;
let sharedCorrelator: Correlator | undefined;

/** Drop the process-wide recorder and correlator. Intended for test isolation. */
export function resetTraceSession(): void {
  sharedRecorder = undefined;
  sharedCorrelator = undefined;
}

function sessionRecorder(): EventRecorder {
  sharedRecorder ??= createRecorder({ adapter: ADAPTER });
  return sharedRecorder;
}

/**
 * A caller-supplied recorder replaces the shared one without bringing it into
 * existence; the correlator is always shared, since spanning instances is the
 * whole point of grouping.
 */
export function openSession(recorder?: EventRecorder): {
  recorder: EventRecorder;
  correlator: Correlator;
} {
  sharedCorrelator ??= createCorrelator();
  return {
    recorder: recorder ?? sessionRecorder(),
    correlator: sharedCorrelator,
  };
}

/** One NDJSON line per event on stdout — the encoding the file sink uses. */
export function consoleWriter(): EventWriter {
  return {
    write(event): void {
      console.log(encodeEventLine(event));
    },
    close(): void {
      /* stdout is not ours to close */
    },
  };
}

export function isDisabled(): boolean {
  // `process` may be absent in browser/edge runtimes, where reading it unguarded
  // would throw a ReferenceError straight out of trace().
  return (
    typeof process !== "undefined" && process.env.HAIA_TRACE_DISABLE === "1"
  );
}
