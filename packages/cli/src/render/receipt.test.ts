import type { Receipt } from "@usehaia/trace-core";
import { describe, expect, it } from "vitest";

import type { StoredReceipt } from "../store.js";
import { renderReceipt, renderReceiptList, renderReceipts } from "./receipt.js";

/** A stored receipt for the listing tests, with only the fields it renders. */
function stored(
  run: string,
  operation: string,
  completeness: Receipt["completeness"] = "full",
  title?: string,
): StoredReceipt {
  return {
    run,
    operation,
    path: `${run}~${operation}.json`,
    receipt: {
      operation: {
        template: "x402-buyer",
        version: 1,
        operation_id: operation,
        ...(title === undefined ? {} : { title }),
      },
      completeness,
      stages: [],
      missing: [],
      exceptions: [],
      events: [],
    },
  };
}

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

describe("renderReceipts", () => {
  const one = stored("run", "op-1").receipt;
  const two = stored("run", "op-2", "partial").receipt;

  it("rules consecutive receipts apart", () => {
    const out = renderReceipts([one, two]);
    expect(out).toContain("────");
    // The rule goes between them, never before the first or after the last.
    expect(out.indexOf("────")).toBeGreaterThan(out.indexOf("op-1"));
    expect(out.indexOf("────")).toBeLessThan(out.indexOf("op-2"));
    expect(
      out.split("\n").filter((line) => line.includes("────")),
    ).toHaveLength(1);
  });

  it("renders nothing for an empty list", () => {
    // A caller with no receipts says so in its own words — `build` names the run
    // that held none — so this must not contribute a stray blank line.
    expect(renderReceipts([])).toBe("");
  });
});

describe("renderReceiptList", () => {
  it("groups by run and counts across them", () => {
    const out = renderReceiptList([
      stored("1721709600000", "op-1"),
      stored("1721709600000", "op-2", "partial"),
      stored("1721712000000", "op-1"),
    ]);

    expect(out).toContain("run 1721709600000");
    expect(out).toContain("run 1721712000000");
    expect(out).toContain("FULL");
    expect(out).toContain("PARTIAL");
    expect(out).toContain("3 receipts across 2 runs.");
    // The index states the verdict, not the stages — that is what `show` is for.
    expect(out).not.toContain("confirmed");
  });

  it("aligns the verdict column across runs, not within each", () => {
    // A width taken per group would step in and out as the listing scrolls.
    const out = renderReceiptList([
      stored("run-a", "op-1"),
      stored("run-b", "a-much-longer-operation-id", "partial"),
    ]);
    const columns = out
      .split("\n")
      .filter((line) => line.includes("FULL") || line.includes("PARTIAL"))
      .map((line) => line.indexOf("FULL") + line.indexOf("PARTIAL") + 1);

    expect(columns).toHaveLength(2);
    expect(columns[0]).toBe(columns[1]);
  });

  it("names a single receipt in the singular, without a run count", () => {
    const out = renderReceiptList([stored("run", "op-1")]);
    expect(out).toContain("1 receipt.");
    expect(out).not.toContain("across");
  });

  it("carries an operation's title when the receipt has one", () => {
    const out = renderReceiptList([
      stored("run", "op-1", "full", "buy the dataset"),
    ]);
    expect(out).toContain("buy the dataset");
  });
});
