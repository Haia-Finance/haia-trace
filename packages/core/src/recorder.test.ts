import { describe, expect, it } from "vitest";

import { createRecorder, type EventWriter, type TraceEvent } from "./index.js";

describe("createRecorder", () => {
  it("stamps adapter and assigns seq monotonically from 0", () => {
    const rec = createRecorder({ adapter: "trace-x402" });
    const a = rec.event({ event_type: "x402.payment.required", payload: {} });
    const b = rec.event({ event_type: "x402.settle.ok", payload: {} });
    expect(a.adapter).toBe("trace-x402");
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
  });

  it("passes through event_type, payload, role, and context_id", () => {
    const rec = createRecorder({ adapter: "trace-x402" });
    const e = rec.event({
      event_type: "x402.payment.required",
      payload: { amount: "1000" },
      role: "client",
      context_id: "ctx-a",
    });
    expect(e.event_type).toBe("x402.payment.required");
    expect(e.payload).toEqual({ amount: "1000" });
    expect(e.role).toBe("client");
    expect(e.context_id).toBe("ctx-a");
  });

  it("omits optional fields when not supplied rather than setting them undefined", () => {
    const rec = createRecorder({ adapter: "trace-x402" });
    const e = rec.event({
      event_type: "chain.transfer.confirmed",
      payload: {},
    });
    expect("context_id" in e).toBe(false);
    expect("role" in e).toBe(false);
  });

  it("uses injected now/newId so output is deterministic for tests", () => {
    let n = 0;
    const rec = createRecorder({
      adapter: "trace-x402",
      now: () => "2026-07-21T12:30:00.000Z",
      newId: () => `evt-${n++}`,
    });
    const a = rec.event({ event_type: "x402.payment.required", payload: {} });
    const b = rec.event({ event_type: "x402.settle.ok", payload: {} });
    expect(a.event_id).toBe("evt-0");
    expect(a.occurred_at).toBe("2026-07-21T12:30:00.000Z");
    expect(b.event_id).toBe("evt-1");
  });

  it("prefers a supplied occurred_at over the clock — fact time for after-the-fact sources", () => {
    const rec = createRecorder({
      adapter: "trace-circle",
      now: () => "2026-07-29T12:15:00.000Z", // delivery time — must NOT win
    });
    const e = rec.event({
      event_type: "circle.transactions.inbound",
      payload: {},
      occurred_at: "2026-07-29T12:00:00.412Z", // the fact's own timestamp
    });
    expect(e.occurred_at).toBe("2026-07-29T12:00:00.412Z");
  });

  it("falls back to the clock when occurred_at is not supplied", () => {
    const rec = createRecorder({
      adapter: "trace-x402",
      now: () => "2026-07-29T12:15:00.000Z",
    });
    const e = rec.event({ event_type: "x402.settle.ok", payload: {} });
    expect(e.occurred_at).toBe("2026-07-29T12:15:00.000Z");
  });

  it("defaults event_id to a unique uuid per event", () => {
    const rec = createRecorder({ adapter: "trace-x402" });
    const ids = new Set(
      Array.from(
        { length: 100 },
        () => rec.event({ event_type: "x402.settle.ok", payload: {} }).event_id,
      ),
    );
    expect(ids.size).toBe(100);
  });

  it("keeps counters independent across sessions", () => {
    const one = createRecorder({ adapter: "trace-x402" });
    const two = createRecorder({ adapter: "trace-x402" });
    one.event({ event_type: "x402.settle.ok", payload: {} });
    expect(two.event({ event_type: "x402.settle.ok", payload: {} }).seq).toBe(
      0,
    );
  });

  describe("record", () => {
    /** A minimal in-memory sink with a switchable verdict. */
    function memoryWriter(accept = true) {
      const events: TraceEvent[] = [];
      return {
        events,
        writer: {
          write(event: TraceEvent): boolean {
            if (!accept) return false;
            events.push(event);
            return true;
          },
          close(): void {},
        } satisfies EventWriter,
      };
    }

    it("stamps and writes in one call, returning the writer's verdict", () => {
      const sink = memoryWriter();
      const rec = createRecorder({
        adapter: "escrow-arc-app",
        writer: sink.writer,
      });

      const accepted = rec.record({
        event_type: "escrow.work.delivered",
        context_id: "0xabc",
        payload: { agreement_id: "agr-1" },
      });

      expect(accepted).toBe(true);
      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]?.event_type).toBe("escrow.work.delivered");
      expect(sink.events[0]?.adapter).toBe("escrow-arc-app");
      expect(sink.events[0]?.seq).toBe(0);
    });

    it("passes the sink's refusal through", () => {
      const sink = memoryWriter(false);
      const rec = createRecorder({ adapter: "a", writer: sink.writer });
      expect(rec.record({ event_type: "e", payload: {} })).toBe(false);
    });

    it("shares one seq counter with event(), so the stream stays ordered", () => {
      const sink = memoryWriter();
      const rec = createRecorder({ adapter: "a", writer: sink.writer });
      const stamped = rec.event({ event_type: "first", payload: {} });
      rec.record({ event_type: "second", payload: {} });
      expect(stamped.seq).toBe(0);
      expect(sink.events[0]?.seq).toBe(1);
    });

    it("throws a TypeError naming the fix when no writer was bound", () => {
      // A caller mistake, deterministic on the first call — the same rule that
      // lets createRunEventWriter throw on a missing directory.
      const rec = createRecorder({ adapter: "a" });
      expect(() => rec.record({ event_type: "e", payload: {} })).toThrow(
        /createRecorder\(\{ adapter, writer \}\)/,
      );
    });
  });
});
