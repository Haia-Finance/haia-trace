import { describe, expect, it } from "vitest";

import { type OperationTemplate } from "./index.js";

describe("Template Contract", () => {
  // The canonical x402 payment template: intent -> payment -> settlement ->
  // paid_action -> business_record, plus the events that break the flow.
  const x402Payment: OperationTemplate = {
    template: "x402-payment",
    version: 1,
    stages: [
      { id: "intent", required: true, match: [{ event: "x402.payment.required" }] },
      { id: "payment", required: true, match: [{ event: "x402.payment.submitted" }] },
      {
        id: "settlement",
        required: true,
        // Match-set is an OR: the same milestone seen from three sides.
        match: [
          { event: "x402.payment.responded" },
          { event: "x402.settle.ok" },
          { event: "chain.transfer.confirmed" },
        ],
      },
      {
        id: "paid_action",
        required: true,
        match: [{ event: "x402.paid_action.executed" }, { event: "http.response.delivered" }],
        missing_explanation: "settlement confirmed, but the paid action's result was not observed",
      },
      { id: "business_record", required: false, match: [{ event: "file.order.recorded" }] },
    ],
    exceptions: ["x402.verify.failed", "x402.settle.failed", "x402.payment.creation_failed"],
  };

  it("expresses the canonical x402-payment template", () => {
    expect(x402Payment.stages).toHaveLength(5);
    expect(x402Payment.exceptions).toContain("x402.verify.failed");
  });

  it("treats a stage's match as an OR-set of witnesses", () => {
    const settlement = x402Payment.stages.find((s) => s.id === "settlement");
    // Any one of the three events closes settlement; the stage lists them all.
    expect(settlement?.match.map((m) => m.event)).toEqual([
      "x402.payment.responded",
      "x402.settle.ok",
      "chain.transfer.confirmed",
    ]);
  });

  it("carries optional stages and an explanation for an unclosed milestone", () => {
    const paidAction = x402Payment.stages.find((s) => s.id === "paid_action");
    const businessRecord = x402Payment.stages.find((s) => s.id === "business_record");
    expect(paidAction?.missing_explanation).toMatch(/not observed/);
    expect(businessRecord?.required).toBe(false);
  });

  // The data-not-code gate: a batch-settlement scenario is a different template
  // file, expressible with no change to any core type (mirrors the Event
  // Contract's x402-vs-MPP agnosticism gate).
  it("expresses a batch-settlement template with no core change", () => {
    const nanopaymentArc: OperationTemplate = {
      template: "nanopayment-arc",
      version: 1,
      stages: [
        { id: "authorization", required: true, match: [{ event: "x402.payment.submitted" }] },
        {
          id: "settlement",
          required: true,
          // One batch confirmation settles many payments at once.
          match: [{ event: "chain.transfer.confirmed" }],
          missing_explanation: "authorization signed, but the settlement batch was not confirmed",
        },
      ],
    };
    expect(nanopaymentArc.template).toBe("nanopayment-arc");
    expect(nanopaymentArc.exceptions).toBeUndefined();
  });
});
