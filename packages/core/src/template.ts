/**
 * The Template Contract — the declarative description of an operation's expected
 * flow, and the second input (alongside events) the receipt assembler consumes.
 *
 * A template is **data, not code**: authored as YAML that ships with the CLI,
 * parsed into the shapes below, then matched against captured events to build a
 * receipt. A new scenario (a new payment protocol, a new settlement shape) is a
 * new template file, never a change to the assembler.
 *
 * Field names are snake_case to mirror the YAML keys one-to-one, so a parsed
 * template maps straight onto these types — the same rule the Event Contract
 * follows for its on-disk NDJSON shape.
 */

import type { EventType } from "./event.js";

/**
 * One event-type witness in a stage's match-set. An object rather than a bare
 * string so a witness can gain conditions later (e.g. constrain by role) without
 * a breaking change to the template shape.
 */
export interface StageMatch {
  /** The event type that, when observed, closes the stage. Matched against `TraceEvent.event_type`. */
  event: EventType;
}

/**
 * One milestone of an operation. Closed by ANY event in `match` — the match-set
 * is an OR: different roles and sources witness the same milestone differently
 * (a settlement is seen as a client response, a server settle, or a chain
 * confirmation), and all of those events belong to this one stage. An
 * independent or re-checking signal is its own stage instead, not another
 * witness folded into someone else's match-set.
 */
export interface TemplateStage {
  /** Stage id, unique within the template, e.g. `settlement`. Referenced by the receipt. */
  id: string;
  /** Whether the operation can be `full` without this stage confirmed. */
  required: boolean;
  /** The match-set: events any one of which closes this stage. */
  match: StageMatch[];
  /**
   * Plain-language meaning of this stage being unclosed, surfaced in the
   * receipt's `missing` — so an absent milestone reads as an explained gap, not a
   * silent hole.
   */
  missing_explanation?: string;
}

/**
 * A full operation template: its milestones in canonical order plus the events
 * that break the flow. The assembler matches captured events against `stages`
 * and `exceptions` to produce a receipt.
 */
export interface OperationTemplate {
  /** Template id, e.g. `x402-payment`. Recorded on the receipt's operation. */
  template: string;
  /** Template version, for evolving a template's content without ambiguity. */
  version: number;
  /** The operation's milestones, in canonical order. */
  stages: TemplateStage[];
  /**
   * Event types that mark a stage `attention_required` rather than closing it —
   * a failure or fault observed mid-flow (e.g. a verification or settlement
   * failure), which the receipt must surface instead of treating as progress.
   */
  exceptions?: EventType[];
}

/**
 * Validate an untrusted value — typically the result of parsing a template file —
 * into an `OperationTemplate`, throwing a sourced `Error` on the first mismatch.
 *
 * Kept here beside the type, and deliberately pure (no filesystem, no parser), so
 * every loader in every language-neutral surface validates the contract the same
 * way. A malformed template must fail loudly rather than silently produce a wrong
 * receipt — this is a receipt-integrity guarantee, not a convenience check.
 */
export function assertOperationTemplate(value: unknown, source = "<template>"): OperationTemplate {
  const fail = (why: string): never => {
    throw new Error(`invalid template (${source}): ${why}`);
  };

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("expected a mapping at the top level");
  }
  const t = value as Record<string, unknown>;

  if (typeof t.template !== "string") fail("`template` must be a string");
  if (typeof t.version !== "number") fail("`version` must be a number");
  if (!Array.isArray(t.stages) || t.stages.length === 0) {
    fail("`stages` must be a non-empty list");
  }

  const seenIds = new Set<string>();
  (t.stages as unknown[]).forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`stage #${i}: expected a mapping`);
    }
    const s = raw as Record<string, unknown>;
    const id = s.id;
    // Label by id, falling back to the index when the id is missing or blank, so
    // the error always points somewhere the author can locate.
    const at = typeof id === "string" && id !== "" ? `stage ${id}` : `stage #${i}`;
    if (typeof id !== "string" || id === "") fail(`${at}: \`id\` must be a non-empty string`);
    const stageId = id as string;
    // Stage ids must be unique — the assembler keys milestones by id, so a
    // duplicate would silently close the wrong stage.
    if (seenIds.has(stageId)) fail(`${at}: duplicate stage id`);
    seenIds.add(stageId);
    if (typeof s.required !== "boolean") fail(`${at}: \`required\` must be a boolean`);
    if (!Array.isArray(s.match) || s.match.length === 0) {
      fail(`${at}: \`match\` must be a non-empty list`);
    }
    (s.match as unknown[]).forEach((m, j) => {
      if (typeof m !== "object" || m === null || typeof (m as Record<string, unknown>).event !== "string") {
        fail(`${at}, match ${j}: \`event\` must be a string`);
      }
    });
    if (s.missing_explanation !== undefined && typeof s.missing_explanation !== "string") {
      fail(`${at}: \`missing_explanation\` must be a string`);
    }
  });

  if (t.exceptions !== undefined) {
    if (!Array.isArray(t.exceptions) || t.exceptions.some((e) => typeof e !== "string")) {
      fail("`exceptions` must be a list of strings");
    }
  }

  return value as OperationTemplate;
}
