import { describe, expect, it } from "vitest";

import { createRecorder } from "./index.js";

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
    const e = rec.event({ event_type: "chain.transfer.confirmed", payload: {} });
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

  it("defaults event_id to a unique uuid per event", () => {
    const rec = createRecorder({ adapter: "trace-x402" });
    const ids = new Set(
      Array.from({ length: 100 }, () => rec.event({ event_type: "x402.settle.ok", payload: {} }).event_id),
    );
    expect(ids.size).toBe(100);
  });

  it("keeps counters independent across sessions", () => {
    const one = createRecorder({ adapter: "trace-x402" });
    const two = createRecorder({ adapter: "trace-x402" });
    one.event({ event_type: "x402.settle.ok", payload: {} });
    expect(two.event({ event_type: "x402.settle.ok", payload: {} }).seq).toBe(0);
  });
});
