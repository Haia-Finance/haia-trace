import { describe, expect, it } from "vitest";

import { assertOperationTemplate, type OperationTemplate } from "./index.js";

describe("Template Contract", () => {
  // A synthetic payment template: intent -> payment -> settlement ->
  // paid_action -> business_record, plus the events that break the flow.
  const demoPayment: OperationTemplate = {
    template: "demo-payment",
    version: 1,
    stages: [
      {
        id: "intent",
        required: true,
        match: [{ event: "x402.payment.required" }],
      },
      {
        id: "payment",
        required: true,
        match: [{ event: "x402.payment.submitted" }],
      },
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
        match: [
          { event: "x402.paid_action.executed" },
          { event: "http.response.delivered" },
        ],
        missing_explanation: "the paid action's result was not observed",
      },
      {
        id: "business_record",
        required: false,
        match: [{ event: "file.order.recorded" }],
      },
    ],
    exceptions: [
      "x402.verify.failed",
      "x402.settle.failed",
      "x402.payment.creation_failed",
    ],
  };

  it("expresses a multi-stage payment template", () => {
    expect(demoPayment.stages).toHaveLength(5);
    expect(demoPayment.exceptions).toContain("x402.verify.failed");
  });

  it("treats a stage's match as an OR-set of witnesses", () => {
    const settlement = demoPayment.stages.find((s) => s.id === "settlement");
    // Any one of the three events closes settlement; the stage lists them all.
    expect(settlement?.match.map((m) => m.event)).toEqual([
      "x402.payment.responded",
      "x402.settle.ok",
      "chain.transfer.confirmed",
    ]);
  });

  it("carries optional stages and an explanation for an unclosed milestone", () => {
    const paidAction = demoPayment.stages.find((s) => s.id === "paid_action");
    const businessRecord = demoPayment.stages.find(
      (s) => s.id === "business_record",
    );
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
        {
          id: "authorization",
          required: true,
          match: [{ event: "x402.payment.submitted" }],
        },
        {
          id: "settlement",
          required: true,
          // One batch confirmation settles many payments at once.
          match: [{ event: "chain.transfer.confirmed" }],
          missing_explanation:
            "authorization signed, but the settlement batch was not confirmed",
        },
      ],
    };
    expect(nanopaymentArc.template).toBe("nanopayment-arc");
    expect(nanopaymentArc.exceptions).toBeUndefined();
  });
});

describe("assertOperationTemplate", () => {
  const valid = {
    template: "demo-payment",
    version: 1,
    stages: [
      {
        id: "intent",
        required: true,
        match: [{ event: "x402.payment.required" }],
      },
      {
        id: "settlement",
        required: true,
        match: [
          { event: "x402.settle.ok" },
          { event: "chain.transfer.confirmed" },
        ],
        missing_explanation: "settlement not observed",
      },
    ],
    exceptions: ["x402.settle.failed"],
  };

  it("accepts and narrows a valid template", () => {
    const template = assertOperationTemplate(valid, "demo-payment.yaml");
    // The return is typed OperationTemplate; the stages survive intact.
    expect(template.stages.map((s) => s.id)).toEqual(["intent", "settlement"]);
    expect(template.exceptions).toEqual(["x402.settle.failed"]);
  });

  it("rejects a non-object with a sourced message", () => {
    expect(() => assertOperationTemplate("nope", "bad.yaml")).toThrow(
      /invalid template \(bad\.yaml\): expected a mapping/,
    );
  });

  it("rejects a template with no stages", () => {
    expect(() =>
      assertOperationTemplate({ template: "x", version: 1, stages: [] }),
    ).toThrow(/`stages` must be a non-empty list/);
  });

  it("rejects a stage whose match entries lack an event string", () => {
    const bad = {
      template: "x",
      version: 1,
      stages: [{ id: "intent", required: true, match: [{ notEvent: "oops" }] }],
    };
    expect(() => assertOperationTemplate(bad)).toThrow(
      /stage intent, match 0: `event` must be a non-empty string/,
    );
  });

  it("rejects a match entry that is not a mapping at all", () => {
    const bareString = {
      template: "x",
      version: 1,
      stages: [{ id: "intent", required: true, match: ["an.event"] }],
    };
    expect(() => assertOperationTemplate(bareString)).toThrow(
      /stage intent, match 0: `event` must be a non-empty string/,
    );
  });

  it("rejects an empty-string role in a witness's where", () => {
    const blankRole = {
      template: "x",
      version: 1,
      stages: [
        {
          id: "intent",
          required: true,
          match: [{ event: "a", where: { role: "" } }],
        },
      ],
    };
    expect(() => assertOperationTemplate(blankRole)).toThrow(
      /stage intent, match 0: `where.role` must be a non-empty string/,
    );
  });

  it("rejects a role in where that is not a string, on a witness or a fault", () => {
    const numberRole = {
      template: "x",
      version: 1,
      stages: [
        {
          id: "intent",
          required: true,
          match: [{ event: "a", where: { role: 1 } }],
        },
      ],
    };
    expect(() => assertOperationTemplate(numberRole)).toThrow(
      /stage intent, match 0: `where.role` must be a non-empty string/,
    );
    const faultRole = {
      template: "x",
      version: 1,
      stages: [{ id: "intent", required: true, match: [{ event: "a" }] }],
      exceptions: [{ event: "b", where: { role: true } }],
    };
    expect(() => assertOperationTemplate(faultRole)).toThrow(
      /exception 0: `where.role` must be a non-empty string/,
    );
    // A null role is not a scalar at all, and that rule reports first.
    const nullRole = {
      template: "x",
      version: 1,
      stages: [
        {
          id: "intent",
          required: true,
          match: [{ event: "a", where: { role: null } }],
        },
      ],
    };
    expect(() => assertOperationTemplate(nullRole)).toThrow(
      /stage intent, match 0: `where` values must be strings, numbers or booleans/,
    );
  });

  it("rejects a role key on the witness itself and says where it went", () => {
    // The shape templates had before `where` existed. Ignoring the key would
    // silently drop the constraint and let any side close the stage.
    const legacy = {
      template: "x",
      version: 1,
      stages: [
        {
          id: "intent",
          required: true,
          match: [{ event: "a", role: "server" }],
        },
      ],
    };
    expect(() => assertOperationTemplate(legacy)).toThrow(
      /stage intent, match 0: `role` is not a key of a witness — write `where: \{ role: \.\.\. \}`/,
    );
    const legacyFault = {
      template: "x",
      version: 1,
      stages: [{ id: "intent", required: true, match: [{ event: "a" }] }],
      exceptions: [{ event: "b", role: "server" }],
    };
    expect(() => assertOperationTemplate(legacyFault)).toThrow(
      /exception 0: `role` is not a key of a witness/,
    );
  });

  it("rejects an empty-string event witness (a stage that could never close)", () => {
    const blankEvent = {
      template: "x",
      version: 1,
      stages: [{ id: "intent", required: true, match: [{ event: "" }] }],
    };
    expect(() => assertOperationTemplate(blankEvent)).toThrow(
      /stage intent, match 0: `event` must be a non-empty string/,
    );
  });

  it("rejects an empty-string template id", () => {
    const blank = {
      template: "",
      version: 1,
      stages: [{ id: "intent", required: true, match: [{ event: "a" }] }],
    };
    expect(() => assertOperationTemplate(blank)).toThrow(
      /`template` must be a non-empty string/,
    );
  });

  it("rejects an empty-string exception witness", () => {
    const bad = {
      template: "x",
      version: 1,
      stages: [{ id: "intent", required: true, match: [{ event: "a" }] }],
      exceptions: ["x402.settle.failed", ""],
    };
    expect(() => assertOperationTemplate(bad)).toThrow(
      /exception 1: `event` must be a non-empty string/,
    );
  });

  it("rejects an exceptions value that is not a list", () => {
    const bad = {
      template: "x",
      version: 1,
      stages: [{ id: "intent", required: true, match: [{ event: "a" }] }],
      exceptions: "x402.settle.failed",
    };
    expect(() => assertOperationTemplate(bad)).toThrow(
      /`exceptions` must be a list/,
    );
  });

  it("accepts a fault witness in either form, bare type or mapping", () => {
    const template = assertOperationTemplate({
      template: "x",
      version: 1,
      stages: [{ id: "intent", required: true, match: [{ event: "a" }] }],
      exceptions: [
        "x402.settle.failed",
        { event: "$policy_decision", where: { verdict: "rejected" } },
      ],
    });

    // Validation narrows; it never rewrites. A bare type stays a bare type, so
    // a template read back is the template that was written.
    expect(template.exceptions).toEqual([
      "x402.settle.failed",
      { event: "$policy_decision", where: { verdict: "rejected" } },
    ]);
  });

  it("accepts a witness predicated on payload fields", () => {
    const template = assertOperationTemplate({
      template: "x",
      version: 1,
      stages: [
        {
          id: "decision",
          required: true,
          match: [
            {
              event: "$policy_decision",
              where: { verdict: "approved", attempts: 2, cached: true },
            },
          ],
        },
      ],
    });

    expect(template.stages[0]?.match[0]?.where).toEqual({
      verdict: "approved",
      attempts: 2,
      cached: true,
    });
  });

  it("rejects an empty `where` (a condition that constrains nothing)", () => {
    const bad = {
      template: "x",
      version: 1,
      stages: [
        { id: "decision", required: true, match: [{ event: "a", where: {} }] },
      ],
    };
    expect(() => assertOperationTemplate(bad)).toThrow(
      /stage decision, match 0: `where` must be a non-empty mapping/,
    );
  });

  it("rejects a `where` that is not a mapping", () => {
    const bad = {
      template: "x",
      version: 1,
      stages: [
        {
          id: "decision",
          required: true,
          match: [{ event: "a", where: ["verdict"] }],
        },
      ],
    };
    expect(() => assertOperationTemplate(bad)).toThrow(
      /stage decision, match 0: `where` must be a non-empty mapping/,
    );
  });

  it("rejects a non-scalar `where` condition (nothing could equal it)", () => {
    const bad = {
      template: "x",
      version: 1,
      stages: [
        {
          id: "decision",
          required: true,
          match: [{ event: "a", where: { decision: { verdict: "ok" } } }],
        },
      ],
    };
    expect(() => assertOperationTemplate(bad)).toThrow(
      /stage decision, match 0: `where` values must be strings, numbers or booleans/,
    );
  });

  it("rejects a null `where` condition", () => {
    const bad = {
      template: "x",
      version: 1,
      stages: [
        {
          id: "decision",
          required: true,
          match: [{ event: "a", where: { verdict: null } }],
        },
      ],
    };
    expect(() => assertOperationTemplate(bad)).toThrow(
      /stage decision, match 0: `where` values must be strings, numbers or booleans/,
    );
  });

  it("holds a fault witness's `where` to the same rule", () => {
    const bad = {
      template: "x",
      version: 1,
      stages: [{ id: "intent", required: true, match: [{ event: "a" }] }],
      exceptions: [{ event: "$policy_decision", where: {} }],
    };
    expect(() => assertOperationTemplate(bad)).toThrow(
      /exception 0: `where` must be a non-empty mapping/,
    );
  });

  it("rejects a non-number version", () => {
    const bad = {
      template: "x",
      version: "1",
      stages: [{ id: "intent", required: true, match: [{ event: "a" }] }],
    };
    expect(() => assertOperationTemplate(bad)).toThrow(
      /`version` must be a finite number/,
    );
  });

  it("rejects a NaN version (typeof NaN is 'number')", () => {
    const bad = {
      template: "x",
      version: NaN,
      stages: [{ id: "intent", required: true, match: [{ event: "a" }] }],
    };
    expect(() => assertOperationTemplate(bad)).toThrow(
      /`version` must be a finite number/,
    );
  });

  it("rejects a non-boolean required flag", () => {
    const bad = {
      template: "x",
      version: 1,
      stages: [{ id: "intent", required: "yes", match: [{ event: "a" }] }],
    };
    expect(() => assertOperationTemplate(bad)).toThrow(
      /stage intent: `required` must be a boolean/,
    );
  });

  it("rejects duplicate stage ids", () => {
    const dup = {
      template: "x",
      version: 1,
      stages: [
        { id: "settlement", required: true, match: [{ event: "a" }] },
        { id: "settlement", required: true, match: [{ event: "b" }] },
      ],
    };
    expect(() => assertOperationTemplate(dup)).toThrow(
      /stage settlement: duplicate stage id/,
    );
  });

  it("locates a blank-id stage by its index", () => {
    const blank = {
      template: "x",
      version: 1,
      stages: [{ id: "", required: true, match: [{ event: "a" }] }],
    };
    expect(() => assertOperationTemplate(blank)).toThrow(
      /stage #0: `id` must be a non-empty string/,
    );
  });
});
