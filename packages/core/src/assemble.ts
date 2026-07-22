/**
 * The receipt assembler — the deterministic, LLM-free mapping at the heart of
 * Trace: `(events, template) → Receipt`. It matches each event's `event_type`
 * against every stage's match-set (an OR), decides `full` vs `partial` from the
 * required stages, and surfaces unclosed milestones and observed faults.
 *
 * It is a pure function: no wall clock, no random id, no I/O — the same events
 * and template always yield a byte-identical receipt, which is what lets a receipt
 * be reproduced or hashed. Any receipt identity or timestamp is the caller's (the
 * CLI store layer's) concern, not stamped here.
 *
 * A run's event file holds many concurrent operations, told apart by
 * `context_id`. `assembleReceipts` splits a whole run into one receipt per
 * operation; `assembleReceipt` and `assembleProgressively` work on the events of a
 * single operation, already scoped by the caller (one `context_id`, or an
 * explicit `--operation`). Events are put into a total, input-order-independent
 * order before folding, so shuffled input — or events merged from more than one
 * capture session — yields the same receipt.
 *
 * The logic is written as a reducer — `startDraft` → `applyEvent` → `finalize` —
 * so it can be driven either eagerly (`assembleReceipt`) or one event at a time
 * (`assembleProgressively`), and the two provably agree.
 */

import type { EventType, TraceEvent } from "./event.js";
import type { OperationTemplate } from "./template.js";
import type { Receipt, ReceiptException, ReceiptStage } from "./receipt.js";

/** Optional operation identity, passed straight onto the receipt — never invented. */
export interface AssembleOptions {
  /** A human title for the operation. */
  title?: string;
  /** The operation's id, when the caller scoped its events to one. */
  operation_id?: string;
}

/** The result of splitting a whole run into per-operation receipts. */
export interface AssembledRun {
  /**
   * One receipt per operation, grouped by `context_id`, in the deterministic
   * order the operations first appear. Each receipt's `operation.operation_id` is
   * its `context_id`.
   */
  receipts: Receipt[];
  /**
   * Events with no `context_id` — session attestations (`trace.attached` /
   * `trace.attach_failed`) and out-of-band signals (e.g. a chain confirmation
   * added later). They are not attributable to a single operation, so they are
   * kept here rather than forced onto — or silently dropped from — a receipt.
   */
  unassigned: TraceEvent[];
}

/** One snapshot from `assembleReceiptsProgressively`: every operation so far and how far along. */
export interface RunProgress {
  /** Events folded in so far, across all operations; 0 in the baseline snapshot, `total` at the end. */
  processed: number;
  /** Total events in the run — the denominator for a real progress indicator. */
  total: number;
  /** The receipts of the operations seen so far, in first-appearance order. */
  receipts: Receipt[];
  /** The context-less events seen so far. */
  unassigned: TraceEvent[];
}

/** One snapshot from `assembleProgressively`: the receipt so far and how far along. */
export interface ReceiptProgress {
  /** Events folded in so far; 0 in the baseline snapshot, `total` at the end. */
  processed: number;
  /** Total events to fold — the denominator for a real progress indicator. */
  total: number;
  /** The receipt as it stands after `processed` events. */
  receipt: Receipt;
}

/**
 * The reducer's mutable state. Kept internal: callers see only receipts. Witness
 * `event_id`s accrue per stage (index-aligned with `template.stages`); the
 * lookups are precomputed once so each event is O(match-sets it hits).
 */
interface Draft {
  template: OperationTemplate;
  options: AssembleOptions;
  /** Witness `event_id`s per stage, aligned to `template.stages` by index. */
  stageEvents: string[][];
  /** Faults observed so far, in fold order. */
  exceptions: ReceiptException[];
  /** Every event folded so far, already in `seq` order. */
  events: TraceEvent[];
  /** `event_type` → the stage indices whose match-set contains it. */
  typeToStages: Map<EventType, number[]>;
  /** The template's exception event types, for O(1) fault detection. */
  exceptionTypes: Set<EventType>;
}

/** Build the initial reducer state and precompute the match lookups. */
function startDraft(template: OperationTemplate, options: AssembleOptions): Draft {
  const typeToStages = new Map<EventType, number[]>();
  template.stages.forEach((stage, index) => {
    for (const witness of stage.match) {
      const stages = typeToStages.get(witness.event);
      // Dedupe the stage index so a type listed twice in one match-set still
      // records a matching event only once on that stage.
      if (stages === undefined) {
        typeToStages.set(witness.event, [index]);
      } else if (!stages.includes(index)) {
        stages.push(index);
      }
    }
  });

  return {
    template,
    options,
    stageEvents: template.stages.map(() => []),
    exceptions: [],
    events: [],
    typeToStages,
    exceptionTypes: new Set(template.exceptions ?? []),
  };
}

/** Fold one event into the draft: close every stage it witnesses, record it if it's a fault. */
function applyEvent(draft: Draft, event: TraceEvent): void {
  draft.events.push(event);

  const stages = draft.typeToStages.get(event.event_type);
  if (stages !== undefined) {
    for (const index of stages) {
      // Aligned with `template.stages`, so the entry always exists; the guard is
      // for `noUncheckedIndexedAccess`.
      draft.stageEvents[index]?.push(event.event_id);
    }
  }

  if (draft.exceptionTypes.has(event.event_type)) {
    draft.exceptions.push({ event_type: event.event_type, event_id: event.event_id });
  }
}

/** Snapshot the draft as a self-contained receipt. Copies all mutable state. */
function finalize(draft: Draft): Receipt {
  const { template, options } = draft;

  const stages: ReceiptStage[] = template.stages.map((stage, index) => {
    const witnesses = draft.stageEvents[index] ?? [];
    return {
      id: stage.id,
      required: stage.required,
      state: witnesses.length > 0 ? "confirmed" : "not_confirmed",
      events: [...witnesses],
    };
  });

  const missing = template.stages.flatMap((stage, index) => {
    const witnesses = draft.stageEvents[index] ?? [];
    if (!stage.required || witnesses.length > 0) return [];
    return [
      {
        stage: stage.id,
        expected_events: stage.match.map((m) => m.event),
        ...(stage.missing_explanation !== undefined ? { why: stage.missing_explanation } : {}),
      },
    ];
  });

  // `full` only when every required milestone is confirmed, no fault was observed,
  // and at least one stage actually closed. An exception means the operation did
  // not complete cleanly even if its stages happen to be closed; and the
  // at-least-one-confirmed clause stops a template with no required stages plus an
  // empty capture from reading as a clean completion of nothing observed.
  const allRequiredConfirmed = template.stages.every(
    (stage, index) => !stage.required || (draft.stageEvents[index]?.length ?? 0) > 0,
  );
  const anyConfirmed = stages.some((s) => s.state === "confirmed");
  const completeness: Receipt["completeness"] =
    allRequiredConfirmed && anyConfirmed && draft.exceptions.length === 0 ? "full" : "partial";

  return {
    operation: {
      template: template.template,
      version: template.version,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.operation_id !== undefined ? { operation_id: options.operation_id } : {}),
    },
    completeness,
    stages,
    missing,
    exceptions: [...draft.exceptions],
    events: [...draft.events],
  };
}

/**
 * Order a copy of the events deterministically: chronologically by `occurred_at`,
 * then by `seq` to break same-timestamp ties within a session, then by the unique
 * `event_id` as a final total-order tiebreaker. `seq` alone is not enough — it
 * restarts per capture session, so two sessions merged for one operation would
 * collide on `seq` and a stable sort would then leak the input order into the
 * result. The `event_id` tiebreaker makes the order depend only on the event set.
 *
 * `occurred_at` is compared lexically, which is chronological only because the
 * Event Contract fixes it to canonical ISO-8601 UTC at millisecond precision — a
 * fixed-width, zero-padded form. An adapter that emitted some other valid ISO form
 * (an offset instead of `Z`, a different fraction width) would break that; the
 * contract is what this relies on, not the parser.
 *
 * Each event is assumed to appear at most once. The assembler does not dedupe by
 * `event_id`: a genuine duplicate would be counted twice (its id on a stage's
 * `events` and a second copy in `receipt.events`). Since `event_id` is unique, a
 * duplicate means the same event was fed in twice — e.g. one sink file read or
 * merged more than once — which is the caller's job to avoid, not ordering's.
 */
function orderEvents(events: readonly TraceEvent[]): TraceEvent[] {
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...events].sort(
    (a, b) => cmp(a.occurred_at, b.occurred_at) || a.seq - b.seq || cmp(a.event_id, b.event_id),
  );
}

/**
 * The operation an event groups under, or `undefined` when it belongs to none.
 * An absent or empty `context_id` cannot identify an operation — the same rule the
 * template contract applies to unmatchable empty event types.
 */
function operationKey(event: TraceEvent): string | undefined {
  return event.context_id === undefined || event.context_id === "" ? undefined : event.context_id;
}

/** Fold an already-ordered event sequence into a receipt. The one place the reducer runs. */
function foldOrdered(
  ordered: readonly TraceEvent[],
  template: OperationTemplate,
  options: AssembleOptions,
): Receipt {
  const draft = startDraft(template, options);
  for (const event of ordered) applyEvent(draft, event);
  return finalize(draft);
}

/**
 * Assemble the receipt eagerly — the canonical, deterministic path. Equivalent to
 * the final snapshot of `assembleProgressively` over the same inputs.
 */
export function assembleReceipt(
  events: readonly TraceEvent[],
  template: OperationTemplate,
  options: AssembleOptions = {},
): Receipt {
  return foldOrdered(orderEvents(events), template, options);
}

/**
 * Assemble the receipt one event at a time, yielding a snapshot after each — for a
 * CLI that shows real progress and a live-updating receipt as events stream in.
 * The first snapshot is the baseline (0 events folded); the last equals
 * `assembleReceipt` over the same inputs.
 */
export function* assembleProgressively(
  events: readonly TraceEvent[],
  template: OperationTemplate,
  options: AssembleOptions = {},
): Generator<ReceiptProgress> {
  const sorted = orderEvents(events);
  const draft = startDraft(template, options);
  const total = sorted.length;

  yield { processed: 0, total, receipt: finalize(draft) };
  for (const [index, event] of sorted.entries()) {
    applyEvent(draft, event);
    yield { processed: index + 1, total, receipt: finalize(draft) };
  }
}

/**
 * Split a whole run — the events of one recorder session, spanning many
 * concurrent operations — into one receipt per operation, grouped by
 * `context_id`. Events lacking a `context_id` belong to no single operation and
 * are returned in `unassigned` rather than attributed or dropped.
 *
 * Deterministic like the single-operation path: events are put into the total
 * order first, so both the order of `receipts` (by each operation's first
 * appearance) and the contents of each receipt depend only on the event set, not
 * on input order.
 */
export function assembleReceipts(
  events: readonly TraceEvent[],
  template: OperationTemplate,
): AssembledRun {
  // Insertion order follows the total event order, so the operation list is
  // deterministic regardless of how the events arrived.
  const groups = new Map<string, TraceEvent[]>();
  const unassigned: TraceEvent[] = [];

  for (const event of orderEvents(events)) {
    const key = operationKey(event);
    if (key === undefined) {
      unassigned.push(event);
      continue;
    }
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [event]);
    else group.push(event);
  }

  // Each group is already in total order from the single pass above, so fold it
  // directly — no second sort per operation.
  const receipts = [...groups.entries()].map(([context_id, groupEvents]) =>
    foldOrdered(groupEvents, template, { operation_id: context_id }),
  );
  return { receipts, unassigned };
}

/**
 * Split a whole run AND stream it: fold the run's events one at a time, yielding a
 * snapshot of every operation discovered so far after each. For a CLI that shows
 * real progress over a whole run while each operation's receipt fills in live.
 *
 * Like `assembleProgressively` but across all operations at once: the first
 * snapshot is the baseline (nothing folded), and the last equals
 * `assembleReceipts` over the same inputs.
 */
export function* assembleReceiptsProgressively(
  events: readonly TraceEvent[],
  template: OperationTemplate,
): Generator<RunProgress> {
  const sorted = orderEvents(events);
  const total = sorted.length;
  // Insertion order follows the total event order, so the operation list is
  // deterministic and stable as it grows.
  const drafts = new Map<string, Draft>();
  // Cache the finalized receipt per operation and re-finalize only the one an
  // event touches. Re-finalizing every operation on every event would be
  // quadratic over a whole run; a snapshot then just collects the cached
  // receipts (fresh objects, so already-yielded snapshots keep their values).
  // Collecting them is still O(operations) per event, so the whole stream is
  // O(events · operations) — cheap for a CLI progress view over a normal run,
  // but worth knowing before reusing this on a run with very many operations.
  const receipts = new Map<string, Receipt>();
  const unassigned: TraceEvent[] = [];
  // Rebuilt only when an unassigned event arrives; shared by reference between
  // snapshots that did not change it, which is safe because it is never mutated.
  let unassignedView: TraceEvent[] = [];

  const snapshot = (processed: number): RunProgress => ({
    processed,
    total,
    receipts: [...receipts.values()],
    unassigned: unassignedView,
  });

  yield snapshot(0);
  for (const [index, event] of sorted.entries()) {
    const key = operationKey(event);
    if (key === undefined) {
      unassigned.push(event);
      unassignedView = [...unassigned];
    } else {
      let draft = drafts.get(key);
      if (draft === undefined) {
        draft = startDraft(template, { operation_id: key });
        drafts.set(key, draft);
      }
      applyEvent(draft, event);
      receipts.set(key, finalize(draft));
    }
    yield snapshot(index + 1);
  }
}
