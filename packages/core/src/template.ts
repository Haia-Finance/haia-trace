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

/** A scalar a `where` condition compares against — the JSON values a payload field can hold. */
export type MatchValue = string | number | boolean;

/**
 * The one `where` key that does not read the payload. `TraceEvent.role` is a
 * field of the envelope, not of the payload, yet a template needs to name it —
 * an x402 resource server and a facilitator record the same event types for
 * the same payment, and only the role says who did what. Rather than give the
 * role a predicate of its own, `where` reserves this key: `where: { role: x }`
 * compares against `TraceEvent.role`, every other key against the payload.
 * One predicate, one rule, and a control plane that folds the role into the
 * event's properties reads the same template with no special case at all.
 */
export const ROLE_KEY = "role";

/**
 * A predicate over one event: the type it must have, and — through `where` — the
 * payload (and role) it must carry. A stage witness and a fault witness are the
 * same shape; only where they sit in the template gives them their meaning.
 */
export interface EventMatch {
  /** The event type this matches. Compared against `TraceEvent.event_type`. */
  event: EventType;
  /**
   * Conditions on `TraceEvent.payload`, **all** of which must hold. Absent means
   * the type alone decides. The key `role` is the exception — see `ROLE_KEY`.
   *
   * Deliberately the smallest thing that works: top-level field names compared
   * for strict equality against scalars. No dotted paths, no comparison
   * operators, no patterns — widening this later is cheap, narrowing it once
   * templates depend on it is not. A field the event does not carry never
   * matches, and `===` means `1` is not `"1"` and `true` is not `1`.
   */
  where?: Record<string, MatchValue>;
}

/**
 * One event-type witness in a stage's match-set. An object rather than a bare
 * string so a witness can gain conditions without a breaking change to the
 * template shape — which is what `where` was.
 */
export type StageMatch = EventMatch;

/**
 * One fault witness. A bare event type is the shorthand for `{ event: <type> }`:
 * `exceptions` was a plain list of types before it could carry conditions, and
 * every shipped template is still written that way.
 */
export type ExceptionMatch = EventType | EventMatch;

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
  /** Template id, e.g. `x402-buyer`. Recorded on the receipt's operation. */
  template: string;
  /** Template version, for evolving a template's content without ambiguity. */
  version: number;
  /** The operation's milestones, in canonical order. */
  stages: TemplateStage[];
  /**
   * Faults observed mid-flow (e.g. a verification or settlement failure), which
   * the receipt must surface instead of treating as progress. A bare event type
   * faults on every occurrence; the `{ event, where }` form faults only on the
   * payloads it names, so one type can be a milestone under one outcome and a
   * fault under another.
   */
  exceptions?: ExceptionMatch[];
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
export function assertOperationTemplate(
  value: unknown,
  source = "<template>",
): OperationTemplate {
  const fail = (why: string): never => {
    throw new Error(`invalid template (${source}): ${why}`);
  };

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("expected a mapping at the top level");
  }
  const t = value as Record<string, unknown>;

  // Shared by stage witnesses and fault witnesses: both carry the same `where`.
  const checkWhere = (where: unknown, at: string): void => {
    if (where === undefined) return;
    // Both are the same predicate; a `role` key on the witness itself is the
    // shape templates had before `where` existed, and the message says where
    // it went rather than pretending never to have heard of it.
    // An empty mapping constrains nothing, which makes it indistinguishable
    // from a half-written condition — it would silently widen the witness it
    // was meant to narrow. Refused as loudly as an empty event type.
    if (
      typeof where !== "object" ||
      where === null ||
      Array.isArray(where) ||
      Object.keys(where).length === 0
    ) {
      fail(`${at}: \`where\` must be a non-empty mapping`);
    }
    // Conditions are compared with `===` against a payload field, so anything
    // that is not a scalar could never match.
    const scalars = ["string", "number", "boolean"];
    if (
      Object.values(where as Record<string, unknown>).some(
        (condition) => !scalars.includes(typeof condition),
      )
    ) {
      fail(`${at}: \`where\` values must be strings, numbers or booleans`);
    }
    // A role is compared against `TraceEvent.role`, which is a non-empty string
    // when present: an empty one would match nothing, not every role, and a
    // number could never equal it.
    const role = (where as Record<string, unknown>)[ROLE_KEY];
    if (role !== undefined && (typeof role !== "string" || role === "")) {
      fail(`${at}: \`where.role\` must be a non-empty string`);
    }
  };

  // The old shape, refused with the new one spelled out: silently ignoring
  // the key would drop the constraint and let any side close the stage.
  const checkNoRoleKey = (
    witness: Record<string, unknown>,
    at: string,
  ): void => {
    if (witness.role !== undefined) {
      fail(
        `${at}: \`role\` is not a key of a witness — write \`where: { role: ... }\``,
      );
    }
  };

  if (typeof t.template !== "string" || t.template === "")
    fail("`template` must be a non-empty string");
  // `Number.isFinite` also rejects NaN (which `typeof` reports as "number") and
  // ±Infinity, so a YAML `version: .nan` can't pass as a valid version.
  if (typeof t.version !== "number" || !Number.isFinite(t.version)) {
    fail("`version` must be a finite number");
  }
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
    const at =
      typeof id === "string" && id !== "" ? `stage ${id}` : `stage #${i}`;
    if (typeof id !== "string" || id === "")
      fail(`${at}: \`id\` must be a non-empty string`);
    const stageId = id as string;
    // Stage ids must be unique — the assembler keys milestones by id, so a
    // duplicate would silently close the wrong stage.
    if (seenIds.has(stageId)) fail(`${at}: duplicate stage id`);
    seenIds.add(stageId);
    if (typeof s.required !== "boolean")
      fail(`${at}: \`required\` must be a boolean`);
    if (!Array.isArray(s.match) || s.match.length === 0) {
      fail(`${at}: \`match\` must be a non-empty list`);
    }
    (s.match as unknown[]).forEach((m, j) => {
      const witness =
        typeof m === "object" && m !== null
          ? (m as Record<string, unknown>)
          : undefined;
      const event = witness?.event;
      // The witness is matched by equality against `TraceEvent.event_type`. An
      // empty string can never equal a real (namespaced) event type, so a
      // required stage carrying it could never close — the assembler would report
      // a permanent gap for an operation that actually completed. Reject it as
      // loudly as a missing event, the same as the non-empty `id` rule above.
      if (typeof event !== "string" || event === "") {
        fail(`${at}, match ${j}: \`event\` must be a non-empty string`);
      }
      if (witness !== undefined) checkNoRoleKey(witness, `${at}, match ${j}`);
      checkWhere(witness?.where, `${at}, match ${j}`);
    });
    if (
      s.missing_explanation !== undefined &&
      typeof s.missing_explanation !== "string"
    ) {
      fail(`${at}: \`missing_explanation\` must be a string`);
    }
  });

  if (t.exceptions !== undefined) {
    if (!Array.isArray(t.exceptions)) fail("`exceptions` must be a list");
    (t.exceptions as unknown[]).forEach((raw, i) => {
      const at = `exception ${i}`;
      // A bare event type is the shorthand for `{ event: <type> }`.
      const fault =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : { event: raw };
      // Exceptions are matched by equality like witnesses are, so an empty
      // type is unmatchable noise — the same non-empty rule applies.
      if (typeof fault.event !== "string" || fault.event === "") {
        fail(`${at}: \`event\` must be a non-empty string`);
      }
      checkNoRoleKey(fault, at);
      checkWhere(fault.where, at);
    });
  }

  return value as OperationTemplate;
}
