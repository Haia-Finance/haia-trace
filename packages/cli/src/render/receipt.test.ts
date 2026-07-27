import type { Receipt } from "@usehaia/trace-core";
import { describe, expect, it } from "vitest";

import { renderReceipt } from "./receipt.js";

describe("renderReceipt", () => {
  it("renders a full operation as completed", () => {
    const receipt: Receipt = {
      operation: { template: "x402-buyer", version: 1, operation_id: "op-1" },
      completeness: "full",
      stages: [
        { id: "challenge", required: true, state: "confirmed", events: ["e1"] },
        {
          id: "settlement",
          required: true,
          state: "confirmed",
          events: ["e2"],
        },
      ],
      missing: [],
      exceptions: [],
      events: [],
    };
    const out = renderReceipt(receipt);
    expect(out).toContain("FULL");
    expect(out).toContain("operation completed");
    expect(out).toContain("challenge");
  });

  it("shows the gap and its explanation on a partial operation (not an event dump)", () => {
    const receipt: Receipt = {
      operation: { template: "x402-buyer", version: 1, operation_id: "op-2" },
      completeness: "partial",
      stages: [
        { id: "challenge", required: true, state: "confirmed", events: ["e1"] },
        {
          id: "settlement",
          required: true,
          state: "not_confirmed",
          events: [],
        },
      ],
      missing: [
        {
          stage: "settlement",
          expected_events: ["x402.payment.responded"],
          why: "the payment was submitted, but no settlement response was observed",
        },
      ],
      exceptions: [],
      events: [
        {
          event_id: "e1",
          event_type: "x402.payment.required",
          occurred_at: "t",
          seq: 0,
          adapter: "a",
          payload: {},
        },
      ],
    };
    const out = renderReceipt(receipt);
    expect(out).toContain("PARTIAL");
    expect(out).toContain("operation not complete");
    expect(out).toContain("settlement");
    expect(out).toContain("no settlement response was observed");
    // BR-7: the renderer states status/gaps, it does not print the raw events.
    expect(out).not.toContain("event_id");
    expect(out).not.toContain("occurred_at");
  });

  it("surfaces observed faults in an exceptions block", () => {
    const receipt: Receipt = {
      operation: { template: "x402-seller", version: 1, operation_id: "op-3" },
      completeness: "partial",
      stages: [
        {
          id: "settlement",
          required: true,
          state: "not_confirmed",
          events: [],
        },
      ],
      missing: [{ stage: "settlement", expected_events: ["x402.settle.ok"] }],
      exceptions: [{ event_type: "x402.settle.failed", event_id: "e9" }],
      events: [],
    };
    const out = renderReceipt(receipt);
    expect(out).toContain("exceptions");
    expect(out).toContain("x402.settle.failed");
    // A missing stage without a `why` falls back to its expected events.
    expect(out).toContain("expected one of: x402.settle.ok");
  });
});
