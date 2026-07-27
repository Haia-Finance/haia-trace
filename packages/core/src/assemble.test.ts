import { describe, expect, it } from "vitest";

import {
  assembleProgressively,
  assembleReceipt,
  assembleReceipts,
  assembleReceiptsProgressively,
  createRecorder,
  type OperationTemplate,
  type TraceEvent,
} from "./index.js";

// The canonical x402 payment template (mirrors packages/cli/templates/x402-payment.yaml):
// intent -> payment -> settlement -> paid_action -> business_record, plus faults.
const x402Payment: OperationTemplate = {
  template: "x402-payment",
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

/**
 * Mint a deterministic TraceEvent per type through the real recorder: `seq` runs
 * 0..n in call order and `event_id` is a stable `evt-<seq>`, so golden assertions
 * and cross-call equality hold.
 */
function makeEvents(types: string[]): TraceEvent[] {
  let n = 0;
  const recorder = createRecorder({
    adapter: "trace-x402",
    now: () => "2026-01-01T00:00:00.000Z",
    newId: () => `evt-${n++}`,
  });
  return types.map((event_type) => recorder.event({ event_type, payload: {} }));
}

/**
 * Mint the events of a whole run in one recorder session (so `seq` is shared and
 * monotonic across operations, as in a real sink file). Each entry is
 * `[context_id | undefined, event_type]`; an undefined context_id models a
 * session attestation or out-of-band signal.
 */
function makeRun(entries: Array<[string | undefined, string]>): TraceEvent[] {
  let n = 0;
  const recorder = createRecorder({
    adapter: "trace-x402",
    now: () => "2026-01-01T00:00:00.000Z",
    newId: () => `evt-${n++}`,
  });
  return entries.map(([context_id, event_type]) =>
    recorder.event({
      event_type,
      payload: {},
      ...(context_id !== undefined ? { context_id } : {}),
    }),
  );
}

/** The witnesses that close every required stage of x402-payment, in flow order. */
const REQUIRED_HAPPY_PATH = [
  "x402.payment.required",
  "x402.payment.submitted",
  "x402.settle.ok",
  "x402.paid_action.executed",
];

function stage(receipt: ReturnType<typeof assembleReceipt>, id: string) {
  return receipt.stages.find((s) => s.id === id);
}

describe("assembleReceipt", () => {
  it("confirms every required stage on the happy path -> full", () => {
    const events = makeEvents(REQUIRED_HAPPY_PATH);
    const receipt = assembleReceipt(events, x402Payment);

    expect(receipt.completeness).toBe("full");
    expect(receipt.missing).toEqual([]);
    expect(receipt.exceptions).toEqual([]);
    expect(receipt.operation).toEqual({ template: "x402-payment", version: 1 });

    // Each required stage is confirmed by the event that witnessed it.
    expect(stage(receipt, "intent")).toEqual({
      id: "intent",
      required: true,
      state: "confirmed",
      events: ["evt-0"],
    });
    expect(stage(receipt, "settlement")?.events).toEqual(["evt-2"]);
    // The optional stage stays open but does not block `full`.
    expect(stage(receipt, "business_record")).toEqual({
      id: "business_record",
      required: false,
      state: "not_confirmed",
      events: [],
    });
  });

  it("reports a missing required stage with its explanation -> partial", () => {
    // Settlement confirmed, but the paid action was never observed (the demo fail-case).
    const events = makeEvents([
      "x402.payment.required",
      "x402.payment.submitted",
      "x402.settle.ok",
    ]);
    const receipt = assembleReceipt(events, x402Payment);

    expect(receipt.completeness).toBe("partial");
    expect(stage(receipt, "settlement")?.state).toBe("confirmed");
    expect(stage(receipt, "paid_action")?.state).toBe("not_confirmed");
    expect(receipt.missing).toEqual([
      {
        stage: "paid_action",
        expected_events: [
          "x402.paid_action.executed",
          "http.response.delivered",
        ],
        why: "the paid action's result was not observed",
      },
    ]);
    // The optional business_record is never listed as missing.
    expect(receipt.missing.some((m) => m.stage === "business_record")).toBe(
      false,
    );
  });

  it("closes a stage on any one witness from its OR match-set", () => {
    const events = makeEvents([
      "x402.payment.required",
      "x402.payment.submitted",
      "chain.transfer.confirmed", // the third settlement witness, alone
      "x402.paid_action.executed",
    ]);
    const receipt = assembleReceipt(events, x402Payment);

    expect(receipt.completeness).toBe("full");
    expect(stage(receipt, "settlement")?.state).toBe("confirmed");
  });

  it("lists every witness when more than one closes the same stage", () => {
    const events = makeEvents([
      "x402.payment.required",
      "x402.payment.submitted",
      "x402.settle.ok", // evt-2
      "chain.transfer.confirmed", // evt-3, same settlement milestone
      "x402.paid_action.executed",
    ]);
    const receipt = assembleReceipt(events, x402Payment);

    // Both witnesses, in deterministic order, back the one confirmed stage.
    expect(stage(receipt, "settlement")?.events).toEqual(["evt-2", "evt-3"]);
  });

  it("records a single witness even when a type is listed twice in one match-set", () => {
    // A malformed-but-typed template repeating an event in its match-set must not
    // double-count the one event that closes the stage.
    const dupMatch: OperationTemplate = {
      template: "dup-match",
      version: 1,
      stages: [
        {
          id: "only",
          required: true,
          match: [
            { event: "some.milestone.reached" },
            { event: "some.milestone.reached" },
          ],
        },
      ],
    };

    const receipt = assembleReceipt(
      makeEvents(["some.milestone.reached"]),
      dupMatch,
    );
    expect(receipt.completeness).toBe("full");
    expect(stage(receipt, "only")?.events).toEqual(["evt-0"]);
  });

  it("surfaces a fault and holds the operation to partial even if stages closed", () => {
    const events = makeEvents([...REQUIRED_HAPPY_PATH, "x402.settle.failed"]);
    const receipt = assembleReceipt(events, x402Payment);

    // Every required stage is confirmed, but an observed fault keeps it from `full`.
    expect(
      receipt.stages
        .filter((s) => s.required)
        .every((s) => s.state === "confirmed"),
    ).toBe(true);
    expect(receipt.completeness).toBe("partial");
    expect(receipt.exceptions).toEqual([
      { event_type: "x402.settle.failed", event_id: "evt-4" },
    ]);
  });

  it("keeps an unmatched event in the receipt without attributing it to a stage", () => {
    const events = makeEvents([...REQUIRED_HAPPY_PATH, "some.unknown.event"]);
    const receipt = assembleReceipt(events, x402Payment);

    expect(receipt.events).toHaveLength(5);
    const unknown = receipt.events.find(
      (e) => e.event_type === "some.unknown.event",
    );
    expect(unknown).toBeDefined();
    // No stage references the unmatched event's id.
    expect(
      receipt.stages.every((s) => !s.events.includes(unknown!.event_id)),
    ).toBe(true);
  });

  it("records one event on every stage whose match-set contains its type", () => {
    // The Receipt contract promises "one event can appear on more than one stage."
    // A template where two stages share a witness type must confirm both from the
    // single observed event.
    const shared: OperationTemplate = {
      template: "shared-witness",
      version: 1,
      stages: [
        {
          id: "first",
          required: true,
          match: [{ event: "shared.signal.seen" }],
        },
        {
          id: "second",
          required: true,
          match: [{ event: "shared.signal.seen" }],
        },
      ],
    };

    const receipt = assembleReceipt(makeEvents(["shared.signal.seen"]), shared);
    expect(receipt.completeness).toBe("full");
    expect(stage(receipt, "first")?.events).toEqual(["evt-0"]);
    expect(stage(receipt, "second")?.events).toEqual(["evt-0"]);
  });

  it("carries caller-supplied operation identity, never inventing it", () => {
    const events = makeEvents(REQUIRED_HAPPY_PATH);
    const bare = assembleReceipt(events, x402Payment);
    expect(bare.operation.title).toBeUndefined();
    expect(bare.operation.operation_id).toBeUndefined();

    const titled = assembleReceipt(events, x402Payment, {
      title: "GET /api/data",
      operation_id: "op-7",
    });
    expect(titled.operation).toEqual({
      template: "x402-payment",
      version: 1,
      title: "GET /api/data",
      operation_id: "op-7",
    });
  });

  it("does not call an all-optional template with no evidence full", () => {
    // A template whose every stage is optional must not report a clean completion
    // when nothing was observed — an empty capture is a gap, not a success.
    const allOptional: OperationTemplate = {
      template: "all-optional",
      version: 1,
      stages: [
        {
          id: "note",
          required: false,
          match: [{ event: "some.note.recorded" }],
        },
      ],
    };

    const empty = assembleReceipt([], allOptional);
    expect(empty.completeness).toBe("partial");

    // Once its optional stage is actually witnessed, there is evidence to stand on.
    const witnessed = assembleReceipt(
      makeEvents(["some.note.recorded"]),
      allOptional,
    );
    expect(witnessed.completeness).toBe("full");
  });

  it("is deterministic and order-independent", () => {
    const events = makeEvents(REQUIRED_HAPPY_PATH);

    const first = assembleReceipt(events, x402Payment);
    const second = assembleReceipt(events, x402Payment);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    // Feeding the same events out of order yields the identical receipt.
    const shuffled = assembleReceipt([...events].reverse(), x402Payment);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(first));
  });

  it("stays deterministic when events from two capture sessions collide on seq", () => {
    // Each recorder session restarts seq at 0, so events merged from two sessions
    // for one operation carry duplicate seq values. Ordering must not depend on
    // which file was read first.
    const client = createRecorder({
      adapter: "trace-x402",
      now: () => "2026-01-01T00:00:00.000Z",
      newId: () => "evt-client",
    });
    const chain = createRecorder({
      adapter: "trace-chain",
      now: () => "2026-01-01T00:00:00.000Z",
      newId: () => "evt-chain",
    });
    // Both events get seq 0 and the same occurred_at — only event_id breaks the tie.
    const clientEvent = client.event({
      event_type: "x402.settle.ok",
      payload: {},
    });
    const chainEvent = chain.event({
      event_type: "chain.transfer.confirmed",
      payload: {},
    });
    expect(clientEvent.seq).toBe(chainEvent.seq);

    const forward = assembleReceipt([clientEvent, chainEvent], x402Payment);
    const reverse = assembleReceipt([chainEvent, clientEvent], x402Payment);
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
    // Both settle-witnesses land on settlement in a stable, id-ordered sequence.
    expect(forward.stages.find((s) => s.id === "settlement")?.events).toEqual([
      "evt-chain",
      "evt-client",
    ]);
  });
});

describe("assembleProgressively", () => {
  it("yields a baseline then one snapshot per event, counting to total", () => {
    const events = makeEvents(REQUIRED_HAPPY_PATH);
    const snapshots = [...assembleProgressively(events, x402Payment)];

    expect(snapshots).toHaveLength(events.length + 1);
    expect(snapshots.map((s) => s.processed)).toEqual([0, 1, 2, 3, 4]);
    expect(snapshots.every((s) => s.total === events.length)).toBe(true);

    // The baseline receipt has folded nothing in.
    expect(snapshots[0]!.receipt.events).toEqual([]);
    expect(
      snapshots[0]!.receipt.stages.every((s) => s.state === "not_confirmed"),
    ).toBe(true);
  });

  it("ends at exactly the eager receipt (the reducer/generator agree)", () => {
    const events = makeEvents(REQUIRED_HAPPY_PATH);
    const snapshots = [...assembleProgressively(events, x402Payment)];
    const eager = assembleReceipt(events, x402Payment);

    expect(snapshots.at(-1)!.receipt).toEqual(eager);
  });

  it("handles an empty event set with a single baseline snapshot", () => {
    const snapshots = [...assembleProgressively([], x402Payment)];

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ processed: 0, total: 0 });
    expect(snapshots[0]!.receipt.completeness).toBe("partial");
    expect(snapshots[0]!.receipt.events).toEqual([]);
  });
});

describe("assembleReceipts", () => {
  // One run, two concurrent operations interleaved, plus a session attestation.
  const run = () =>
    makeRun([
      ["a", "x402.payment.required"],
      ["b", "x402.payment.required"],
      ["a", "x402.payment.submitted"],
      ["a", "x402.settle.ok"],
      ["a", "x402.paid_action.executed"], // op a: full
      ["b", "x402.payment.submitted"],
      ["b", "x402.settle.ok"], // op b: paid_action never observed -> partial
      [undefined, "trace.attached"], // session attestation: no operation
    ]);

  it("splits a run into one receipt per context_id, keyed by operation", () => {
    const { receipts } = assembleReceipts(run(), x402Payment);

    expect(receipts).toHaveLength(2);
    // Ordered by first appearance: op a (seq 0) before op b (seq 1).
    expect(receipts.map((r) => r.operation.operation_id)).toEqual(["a", "b"]);

    const [a, b] = receipts;
    expect(a!.completeness).toBe("full");
    expect(a!.events.map((e) => e.context_id)).toEqual(["a", "a", "a", "a"]);

    expect(b!.completeness).toBe("partial");
    expect(b!.missing.map((m) => m.stage)).toEqual(["paid_action"]);
    expect(b!.events.map((e) => e.context_id)).toEqual(["b", "b", "b"]);
  });

  it("keeps context-less events in unassigned, off every receipt", () => {
    const { receipts, unassigned } = assembleReceipts(run(), x402Payment);

    expect(unassigned.map((e) => e.event_type)).toEqual(["trace.attached"]);
    const attestationId = unassigned[0]!.event_id;
    const onSomeReceipt = receipts.some((r) =>
      r.events.some((e) => e.event_id === attestationId),
    );
    expect(onSomeReceipt).toBe(false);
  });

  it("is order-independent: shuffled run input yields the identical split", () => {
    const events = run();
    const forward = assembleReceipts(events, x402Payment);
    const reverse = assembleReceipts([...events].reverse(), x402Payment);
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
  });

  it("returns empty on empty input and buckets an all-attestation run", () => {
    expect(assembleReceipts([], x402Payment)).toEqual({
      receipts: [],
      unassigned: [],
    });

    const onlyAttestations = makeRun([
      [undefined, "trace.attached"],
      [undefined, "trace.attach_failed"],
    ]);
    const { receipts, unassigned } = assembleReceipts(
      onlyAttestations,
      x402Payment,
    );
    expect(receipts).toEqual([]);
    expect(unassigned).toHaveLength(2);
  });

  it('treats an empty-string context_id as no operation, not a group keyed by ""', () => {
    // An empty context_id cannot identify an operation (the same rule the template
    // contract applies to unmatchable empty event types), so it goes to unassigned
    // rather than opening a receipt keyed by "".
    const events = makeRun([
      ["", "x402.payment.required"],
      ["a", "x402.payment.required"],
    ]);
    const { receipts, unassigned } = assembleReceipts(events, x402Payment);

    expect(receipts.map((r) => r.operation.operation_id)).toEqual(["a"]);
    expect(unassigned.map((e) => e.event_type)).toEqual([
      "x402.payment.required",
    ]);
  });
});

describe("assembleReceiptsProgressively", () => {
  const run = () =>
    makeRun([
      ["a", "x402.payment.required"],
      ["b", "x402.payment.required"],
      ["a", "x402.payment.submitted"],
      ["a", "x402.settle.ok"],
      ["a", "x402.paid_action.executed"], // op a: full
      ["b", "x402.payment.submitted"],
      ["b", "x402.settle.ok"], // op b: partial
      [undefined, "trace.attached"], // session attestation
    ]);

  it("yields a baseline then one snapshot per event, counting to total", () => {
    const events = run();
    const snapshots = [...assembleReceiptsProgressively(events, x402Payment)];

    expect(snapshots).toHaveLength(events.length + 1);
    expect(snapshots.map((s) => s.processed)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(snapshots.every((s) => s.total === events.length)).toBe(true);

    // The baseline has nothing folded in.
    expect(snapshots[0]!.receipts).toEqual([]);
    expect(snapshots[0]!.unassigned).toEqual([]);
  });

  it("grows the operation set as each new context_id first appears", () => {
    const snapshots = [...assembleReceiptsProgressively(run(), x402Payment)];

    // op a's first event opens one operation; op b's first event opens the second.
    expect(snapshots[1]!.receipts.map((r) => r.operation.operation_id)).toEqual(
      ["a"],
    );
    expect(snapshots[2]!.receipts.map((r) => r.operation.operation_id)).toEqual(
      ["a", "b"],
    );
    // The attestation (last event) lands in unassigned, not on a receipt.
    expect(snapshots.at(-1)!.unassigned.map((e) => e.event_type)).toEqual([
      "trace.attached",
    ]);
  });

  it("ends at exactly the eager split (progressive and assembleReceipts agree)", () => {
    const events = run();
    const last = [...assembleReceiptsProgressively(events, x402Payment)].at(
      -1,
    )!;
    const eager = assembleReceipts(events, x402Payment);

    expect(last).toMatchObject({
      processed: events.length,
      total: events.length,
    });
    expect({ receipts: last.receipts, unassigned: last.unassigned }).toEqual(
      eager,
    );
  });

  it("handles an empty run with a single baseline snapshot", () => {
    const snapshots = [...assembleReceiptsProgressively([], x402Payment)];

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      processed: 0,
      total: 0,
      receipts: [],
      unassigned: [],
    });
  });
});
