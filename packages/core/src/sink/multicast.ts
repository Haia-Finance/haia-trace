/**
 * Fan one event stream out to several writers — how a producer records to more
 * than one sink at a time (a local run file *and* a remote one, say) without
 * knowing that it does: the result is an ordinary `EventWriter`.
 */

import type { TraceEvent } from "../event.js";
import type { EventWriter } from "./contract.js";

/**
 * Every writer is offered every event, whatever the others do. A writer that
 * throws out of `write` is breaking the sink contract, and swallowing that here
 * is deliberate: one misbehaving sink must not deny the events to the rest, and
 * a writer that honours the contract already routes its failures to its own
 * error handler, where the caller configured them.
 *
 * `write` returns the AND of the writers' verdicts: `true` only when every
 * sink accepted the event. This is the conservative reading a caller acting on
 * the result needs — "all sinks have it" is the only answer that lets a
 * webhook receiver acknowledge a delivery — and a caller that treats one sink
 * as best-effort keeps that sink out of the multicast and calls it separately,
 * rather than having this fan-out guess which failures matter.
 */
export function createMulticastEventWriter(
  ...writers: readonly EventWriter[]
): EventWriter {
  const each = (act: (writer: EventWriter) => void): void => {
    for (const writer of writers) {
      try {
        act(writer);
      } catch {
        /* a writer's failure is its own to report; the others still get the call */
      }
    }
  };

  return {
    write(event: TraceEvent): boolean {
      // Not via `each`: a `write` that THROWS (a contract breaker) must land
      // as a refusal, and the shared helper would absorb it out of sight of
      // the accumulator.
      let accepted = true;
      for (const writer of writers) {
        try {
          accepted = writer.write(event) && accepted;
        } catch {
          accepted = false;
        }
      }
      return accepted;
    },
    async flush(): Promise<void> {
      // `allSettled`, not `all`: a rejection from one writer must not skip the
      // others' flushes, and this must resolve however they went. The call is
      // wrapped as well, so a `flush` that throws *synchronously* — before it
      // ever returns a promise — is a settled outcome here rather than an
      // exception thrown out of the `map`, which would skip the writers after it.
      await Promise.allSettled(writers.map(async (writer) => writer.flush?.()));
    },
    close(): void {
      each((writer) => {
        writer.close();
      });
    },
  };
}
