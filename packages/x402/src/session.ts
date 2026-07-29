/**
 * The process-wide capture session, plus the defaults a `trace()` call falls
 * back to when it is given none.
 *
 * The recorder and the correlator are shared across `trace()` calls on purpose:
 * one recorder gives every traced instance a single `seq` sequence, and one
 * correlator lets a client and a server traced in the same process resolve the
 * same payment to the same `context_id` — so both sides of one operation
 * assemble into one receipt.
 */

import {
  createRecorder,
  type EventRecorder,
  type EventWriter,
  encodeEventLine,
} from "@usehaia/trace-core";

import { type Correlator, createCorrelator } from "./correlate.js";

/** Id stamped on every event this package produces. */
const ADAPTER = "trace-x402";

let sharedRecorder: EventRecorder | undefined;
let sharedCorrelator: Correlator | undefined;

/** Drop the process-wide recorder and correlator. Intended for test isolation. */
export function resetTraceSession(): void {
  sharedRecorder = undefined;
  sharedCorrelator = undefined;
}

/** The process-wide recorder, started on first use. */
function sessionRecorder(): EventRecorder {
  sharedRecorder ??= createRecorder({ adapter: ADAPTER });
  return sharedRecorder;
}

/**
 * The recorder and correlator one `trace()` call will use. A caller-supplied
 * recorder replaces the shared one without bringing it into existence; the
 * correlator is always the shared one, since spanning instances is the whole
 * point of grouping.
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

/**
 * The default sink: one NDJSON line per event on stdout — the same encoding the
 * file sink uses, so it can be piped straight into a run file.
 */
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

/** Whether capture is switched off for this process. */
export function isDisabled(): boolean {
  // `process` may be absent in browser/edge runtimes (where HTTP clients run);
  // reading it unguarded would throw ReferenceError straight out of trace().
  return (
    typeof process !== "undefined" && process.env.HAIA_TRACE_DISABLE === "1"
  );
}
