import { describe, expect, it } from "vitest";

import type { TraceEvent } from "./index.js";

describe("Event Contract", () => {
  // The agnosticism gate: an x402 event and an MPP-style event both satisfy
  // TraceEvent with no change to any core type between them.
  it("accepts an x402 event", () => {
    const event: TraceEvent = {
      event_id: "018f9c00-0000-7000-8000-000000000001",
      event_type: "x402.payment.required",
      occurred_at: "2026-07-21T12:30:00.123Z",
      context_id: "ctx-a",
      seq: 1,
      adapter: "trace-x402",
      role: "client",
      payload: { amount: "1000", asset: "USDC", network: "base" },
    };
    expect(event.event_type).toBe("x402.payment.required");
  });

  it("accepts an MPP-style event with no core change", () => {
    const event: TraceEvent = {
      event_id: "018f9c00-0000-7000-8000-000000000002",
      event_type: "mpp.charge.authorized",
      occurred_at: "2026-07-21T12:31:00.000Z",
      seq: 4,
      adapter: "trace-mpp",
      role: "payer",
      payload: {},
    };
    expect(event.adapter).toBe("trace-mpp");
  });

  // Two concurrent requests to the same resource in one run: identical but for
  // context_id, which the adapter captures at hook-fire time to keep them apart.
  it("distinguishes concurrent same-resource operations by context_id", () => {
    const common = {
      event_type: "x402.payment.required",
      occurred_at: "2026-07-21T12:30:00.000Z",
      adapter: "trace-x402",
      role: "client",
      payload: { resource: "/api/foo" },
    } as const;
    const a: TraceEvent = {
      ...common,
      event_id: "evt-a",
      seq: 10,
      context_id: "ctx-a",
    };
    const b: TraceEvent = {
      ...common,
      event_id: "evt-b",
      seq: 11,
      context_id: "ctx-b",
    };
    expect(a.context_id).not.toBe(b.context_id);
  });

  it("carries a coverage attestation as a first-class event, keyed by event_type", () => {
    const event: TraceEvent = {
      event_id: "018f9c00-0000-7000-8000-000000000003",
      event_type: "trace.attached",
      occurred_at: "2026-07-21T12:29:59.000Z",
      seq: 0,
      adapter: "trace-x402",
      // Protocol, adapter version, and traced instance ride here, not on every event.
      payload: {
        protocol: "x402/v2",
        adapter_version: "0.1.0",
        instance: "x402HTTPClient",
        attached: ["onPaymentRequired"],
      },
    };
    expect(event.event_type).toBe("trace.attached");
  });
});
