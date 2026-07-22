/**
 * The Receipt Contract — the single verdict the assembler produces from events +
 * a template, and the object every surface (terminal, `receipt.json`, markdown)
 * renders. It states what completed, what is missing, and which faults were
 * observed for one payment operation.
 *
 * Field names are snake_case to mirror the on-disk `receipt.json` one-to-one, the
 * same rule the Event and Template contracts follow for their serialized shapes.
 *
 * A receipt is produced by us, not parsed from untrusted input, so there is no
 * validator here (unlike `assertOperationTemplate`).
 */

import type { EventType, TraceEvent } from "./event.js";

/**
 * A stage's verdict. `confirmed` when at least one witness from its match-set was
 * observed; `not_confirmed` otherwise.
 *
 * There is deliberately no `attention_required` yet: attributing an exception to a
 * specific stage would need the template to link the two, which the flat
 * `exceptions` list does not express. Faults surface at the operation level
 * (`Receipt.exceptions`) until that link exists.
 */
export type StageState = "confirmed" | "not_confirmed";

/** One milestone's verdict, keyed to a `TemplateStage` by `id`. */
export interface ReceiptStage {
  /** Matches the `TemplateStage.id` it reports on. */
  id: string;
  /** Carried over from the template, so a reader sees whether a gap blocks `full`. */
  required: boolean;
  /** Whether a witness closed this stage. */
  state: StageState;
  /**
   * `event_id`s of the witnesses that closed this stage — the evidence behind a
   * `confirmed` verdict. Empty when `not_confirmed`. One event can appear on more
   * than one stage if its type sits in several match-sets.
   */
  events: string[];
}

/**
 * A required stage left unclosed — surfaced so an absent milestone reads as an
 * explained gap, never a silent hole — the receipt states absence rather than
 * hiding it. Optional stages never appear here.
 */
export interface ReceiptMissing {
  /** The `TemplateStage.id` that stayed `not_confirmed`. */
  stage: string;
  /** The stage's match-set event types — what any one of would have closed it. */
  expected_events: EventType[];
  /** The stage's `missing_explanation`, when the template gave one. */
  why?: string;
}

/**
 * An observed fault: an event whose type is in the template's `exceptions`. A
 * fault does not close a stage and keeps the operation from being cleanly `full`.
 */
export interface ReceiptException {
  /** The exception event's type, e.g. `x402.settle.failed`. */
  event_type: EventType;
  /** The `event_id` of the observed exception event — its provenance. */
  event_id: string;
}

/** Which operation this receipt is a verdict on. */
export interface ReceiptOperation {
  /** The template id the verdict was built against, e.g. `x402-payment`. */
  template: string;
  /** The template version, carried over for unambiguous reproduction. */
  version: number;
  /** A human title for the operation, when the caller has one. Never invented here. */
  title?: string;
  /** The operation's id, when the caller scoped its events to one. Never invented here. */
  operation_id?: string;
}

/**
 * The verdict on one payment operation: its stages' states with evidence, the
 * required milestones still missing, the faults observed, and the full set of
 * discovered events for provenance.
 */
export interface Receipt {
  /** The operation under verdict. */
  operation: ReceiptOperation;
  /**
   * `full` only when every required stage is confirmed, at least one stage
   * actually closed, and no fault was observed; else `partial`. The
   * at-least-one-closed clause keeps a template with no required stages plus an
   * empty capture from reading as a clean completion of nothing observed.
   */
  completeness: "full" | "partial";
  /** Every template stage, in template order, with its verdict. */
  stages: ReceiptStage[];
  /** Required stages left unclosed, each with an explanation. */
  missing: ReceiptMissing[];
  /** Faults observed mid-flow. */
  exceptions: ReceiptException[];
  /**
   * Every discovered event, in a deterministic order (chronological by
   * `occurred_at`, then `seq`, then `event_id`), so the receipt is self-contained
   * provenance. Events matched to no stage simply appear here unreferenced.
   */
  events: TraceEvent[];
}
