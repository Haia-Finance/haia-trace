import { describe, expect, it } from "vitest";

import {
  assembleProgressively,
  assembleReceipt,
  assembleReceipts,
  createRecorder,
  type OperationTemplate,
  type Receipt,
  type TraceEvent,
} from "./index.js";

/**
 * Property tests for the assembler's determinism claims — "same events, same
 * Receipt" — checked over many generated runs rather than one hand-written
 * case. Each property is stated once in prose above its test; the generator
 * below is a small seeded PRNG so a failure prints a seed that reproduces it.
 *
 * The template covers every matching feature: an OR match-set, an optional
 * stage, a role-constrained witness, a payload-predicated witness, and both
 * fault shapes.
 */
const template: OperationTemplate = {
  template: "property-payment",
  version: 1,
  stages: [
    {
      id: "challenge",
      required: true,
      match: [{ event: "pay.required", where: { role: "client" } }],
    },
    {
      id: "payment",
      required: true,
      match: [{ event: "pay.submitted" }],
    },
    {
      id: "settlement",
      required: true,
      match: [
        { event: "pay.responded", where: { success: true } },
        { event: "chain.confirmed" },
      ],
    },
    {
      id: "record",
      required: false,
      match: [{ event: "ledger.recorded" }],
    },
  ],
  exceptions: [
    "pay.failed",
    { event: "pay.responded", where: { success: false } },
  ],
};

/** Every event type the generator may emit, including ones no stage names. */
const TYPES = [
  "pay.required",
  "pay.submitted",
  "pay.responded",
  "chain.confirmed",
  "ledger.recorded",
  "pay.failed",
  "trace.noise",
] as const;

const ROLES = ["client", "server", undefined] as const;

/** A tiny LCG: enough to vary shapes, deterministic across runs and platforms. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function shuffle<T>(rand: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * One recorder session with up to three operations, random types, roles and
 * payloads, plus the occasional context-less event. Timestamps are spread
 * across a few distinct values so both the `occurred_at` and the `seq`
 * comparisons are exercised.
 */
function makeRun(seed: number): TraceEvent[] {
  const rand = prng(seed);
  let n = 0;
  let clock = 0;
  const recorder = createRecorder({
    adapter: "trace-test",
    now: () => `2026-01-01T00:00:0${Math.min(clock, 9)}.000Z`,
    newId: () => `evt-${seed}-${n++}`,
  });
  const operations = ["op-a", "op-b", "op-c"].slice(
    0,
    1 + Math.floor(rand() * 3),
  );
  const count = 1 + Math.floor(rand() * 12);
  const events: TraceEvent[] = [];
  for (let i = 0; i < count; i++) {
    if (rand() < 0.3) clock++;
    const role = pick(rand, ROLES);
    const context_id = rand() < 0.15 ? undefined : pick(rand, operations);
    events.push(
      recorder.event({
        event_type: pick(rand, TYPES),
        payload: { success: rand() < 0.7, n: i },
        ...(role !== undefined ? { role } : {}),
        ...(context_id !== undefined ? { context_id } : {}),
      }),
    );
  }
  return events;
}

const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);

const canonical = (value: unknown) => JSON.stringify(value);

function confirmed(receipt: Receipt): Set<string> {
  return new Set(
    receipt.stages.filter((s) => s.state === "confirmed").map((s) => s.id),
  );
}

describe("assembler properties", () => {
  // Any permutation of a run's events yields the identical split and the
  // identical receipts: the order events were read in leaves no trace.
  it("is invariant under permutation of the input", () => {
    for (const seed of SEEDS) {
      const events = makeRun(seed);
      const baseline = canonical(assembleReceipts(events, template));
      const rand = prng(seed * 7919);
      for (let round = 0; round < 3; round++) {
        const permuted = shuffle(rand, events);
        expect(
          canonical(assembleReceipts(permuted, template)),
          `seed ${seed}, round ${round}`,
        ).toBe(baseline);
      }
    }
  });

  // The progressive generator's k-th snapshot is exactly the eager receipt
  // over the first k events in total order — not merely its last snapshot.
  it("agrees with the eager path at every prefix, not only at the end", () => {
    for (const seed of SEEDS) {
      const events = makeRun(seed).filter((e) => e.context_id === "op-a");
      const snapshots = [...assembleProgressively(events, template)];
      // The generator orders internally; recover that order from the final
      // receipt, whose `events` are in the total order.
      const ordered = snapshots[snapshots.length - 1]!.receipt.events;
      snapshots.forEach((snapshot, k) => {
        expect(snapshot.processed).toBe(k);
        expect(canonical(snapshot.receipt), `seed ${seed}, prefix ${k}`).toBe(
          canonical(assembleReceipt(ordered.slice(0, k), template)),
        );
      });
    }
  });

  // Evidence only accumulates: adding events can close a stage or add a
  // fault, never reopen a stage or remove one. A truncated capture therefore
  // reads as a partial view of the same operation, not a different one.
  it("is monotonic: a longer prefix never loses confirmations or faults", () => {
    for (const seed of SEEDS) {
      const events = makeRun(seed).filter((e) => e.context_id === "op-a");
      let previous: Receipt | undefined;
      for (const { receipt } of assembleProgressively(events, template)) {
        if (previous !== undefined) {
          const before = confirmed(previous);
          for (const id of before) {
            expect(confirmed(receipt).has(id), `seed ${seed}`).toBe(true);
          }
          expect(receipt.exceptions.length).toBeGreaterThanOrEqual(
            previous.exceptions.length,
          );
          for (const stage of previous.stages) {
            const now = receipt.stages.find((s) => s.id === stage.id)!;
            expect(now.events.slice(0, stage.events.length)).toEqual(
              stage.events,
            );
          }
        }
        previous = receipt;
      }
    }
  });

  // Feeding one run twice is not the same as feeding it once: the assembler
  // does not dedupe by event_id, so every witness and every event appears
  // twice. This pins the documented contract — a reader that merges the same
  // file into a set twice has made a mistake the assembler will not hide —
  // so that introducing dedupe later is a deliberate change, not a drift.
  it("counts a duplicated run twice rather than silently deduping", () => {
    for (const seed of SEEDS) {
      const events = makeRun(seed);
      const once = assembleReceipts(events, template);
      const twice = assembleReceipts([...events, ...events], template);
      expect(twice.receipts.length).toBe(once.receipts.length);
      expect(twice.unassigned.length).toBe(once.unassigned.length * 2);
      once.receipts.forEach((receipt, i) => {
        const doubled = twice.receipts[i]!;
        expect(doubled.events.length).toBe(receipt.events.length * 2);
        expect(doubled.completeness).toBe(receipt.completeness);
        receipt.stages.forEach((stage, j) => {
          expect(doubled.stages[j]!.events.length).toBe(
            stage.events.length * 2,
          );
        });
      });
    }
  });

  // Two capture sessions of one operation restart seq at zero and may share
  // timestamps; the event_id tiebreak keeps the merged order total. Checked
  // across permutations of the merged set, not just the two session orders.
  it("stays order-independent when two sessions collide on seq and time", () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const sessions = ["s1", "s2"].map((tag) => {
        let n = 0;
        const recorder = createRecorder({
          adapter: `trace-${tag}`,
          now: () => "2026-01-01T00:00:00.000Z",
          newId: () => `${tag}-${n++}`,
        });
        const rand = prng(seed * 31 + tag.length);
        return Array.from({ length: 1 + Math.floor(rand() * 5) }, () =>
          recorder.event({
            event_type: pick(rand, TYPES),
            payload: { success: rand() < 0.5 },
            context_id: "op",
            role: "client",
          }),
        );
      });
      const merged = sessions.flat();
      const baseline = canonical(assembleReceipt(merged, template));
      const rand = prng(seed);
      for (let round = 0; round < 3; round++) {
        expect(
          canonical(assembleReceipt(shuffle(rand, merged), template)),
          `seed ${seed}`,
        ).toBe(baseline);
      }
    }
  });
});
