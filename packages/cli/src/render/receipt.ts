/**
 * Terminal renderer for a Receipt — the product's core surface: it states
 * "status / gaps", never a list of events.
 *
 * This is the "not a log viewer" guarantee in code (BR-7). The renderer shows each
 * milestone's verdict, the required gaps with their plain-language meaning, and the
 * faults observed — and deliberately never prints `receipt.events`. Kept as its own
 * module because every command that shows a receipt — `sample`, `build`, and
 * `receipt show` — renders through these functions, so one verdict looks the same
 * wherever it is read.
 *
 * All three return a string rather than printing, so callers control output and
 * tests can assert on it.
 */

import type { Receipt } from "@usehaia/trace-core";

import type { StoredReceipt } from "../store.js";
import { color, emoji, symbol } from "../ui.js";

/**
 * The completeness verdict as a coloured badge: green for a clean full, yellow
 * otherwise. Padded to `width` *inside* the colouring, so a column of badges lines
 * up — measuring a string that already carries escape codes would not.
 */
function badge(completeness: Receipt["completeness"], width = 0): string {
  const paint = completeness === "full" ? color.green : color.yellow;
  const label = completeness === "full" ? "FULL" : "PARTIAL";
  return color.bold(paint(label.padEnd(width)));
}

/** The rule drawn between two receipts shown in sequence. */
const DIVIDER = color.dim("  ────────────────────────────");

/** Render one receipt as a block of terminal text. */
export function renderReceipt(receipt: Receipt): string {
  const { operation, completeness, stages, missing, exceptions } = receipt;
  const dot = color.dim("·");
  const lines: string[] = [];

  // Header: what operation, and the verdict at a glance.
  const parts = [color.bold(operation.template)];
  if (operation.operation_id !== undefined) parts.push(operation.operation_id);
  if (operation.title !== undefined) parts.push(operation.title);
  parts.push(badge(completeness));
  lines.push(`${emoji.receipt} ${parts.join(` ${dot} `)}`);
  lines.push("");

  // Stages, aligned in a column so the eye scans states down the left.
  const width = Math.max(...stages.map((s) => s.id.length));
  for (const stage of stages) {
    const id = stage.id.padEnd(width);
    if (stage.state === "confirmed") {
      lines.push(`  ${symbol.success} ${id}  ${color.green("confirmed")}`);
    } else if (stage.required) {
      lines.push(
        `  ${symbol.error} ${id}  ${color.red("not confirmed")}  ${color.dim("required")}`,
      );
    } else {
      // An unmet optional stage recedes — it does not block a full operation.
      lines.push(color.dim(`  ${symbol.error} ${id}  not confirmed  optional`));
    }
  }

  // Faults observed mid-flow — surfaced above the gaps, since they explain them.
  if (exceptions.length > 0) {
    lines.push("");
    lines.push(`  ${color.yellow("exceptions")}`);
    for (const ex of exceptions) {
      lines.push(`    ${symbol.warning} ${color.yellow(ex.event_type)}`);
    }
  }

  // The gaps: each required milestone left open, with what its absence means.
  if (missing.length > 0) {
    lines.push("");
    lines.push(`  ${color.yellow("missing")}`);
    for (const m of missing) {
      const detail =
        m.why ?? `expected one of: ${m.expected_events.join(", ")}`;
      lines.push(`    ${color.bold(m.stage)} ${color.dim("—")} ${detail}`);
    }
  }

  // Verdict line — the one sentence a human or agent acts on.
  lines.push("");
  lines.push(
    completeness === "full"
      ? `  ${color.green("operation completed")}`
      : `  ${color.yellow("operation not complete")}`,
  );

  return lines.join("\n");
}

/**
 * Several receipts in sequence, ruled apart and each followed by a blank line.
 *
 * One run means several operations, so every command that shows receipts shows a
 * list of them — `build`, `sample` and `receipt show` alike. Rendering that list
 * in one place is what keeps the three from drifting apart in spacing.
 *
 * An empty list renders as the empty string; a caller with nothing to show says so
 * in its own words rather than printing a blank.
 */
export function renderReceipts(receipts: Receipt[]): string {
  const blocks: string[] = [];
  for (const [index, receipt] of receipts.entries()) {
    if (index > 0) blocks.push(DIVIDER);
    // The trailing empty string is the blank line that separates one receipt's
    // verdict from whatever follows it.
    blocks.push(renderReceipt(receipt), "");
  }
  return blocks.join("\n");
}

/**
 * The store's index: every stored receipt, grouped by the run it came from.
 *
 * Deliberately one line per receipt — the run, the operation, the verdict, the
 * template it was judged against. It is the answer to "what is in the store?", not
 * to "what happened in this operation?"; that second question is what
 * `renderReceipt` answers, and printing stages here would blur the two.
 *
 * Operations and badges are padded to a width taken across *all* entries rather
 * than per run, so the columns line up down the whole listing — the same alignment
 * `template list` gives its names.
 */
export function renderReceiptList(entries: StoredReceipt[]): string {
  const lines: string[] = [`${emoji.receipt} ${color.bold("Receipts")}`];
  // Folded rather than spread into `Math.max`: receipts accumulate — a run per
  // agent session, kept as evidence — so the argument list would eventually be
  // long enough to blow the stack, and a store too big to list is exactly the one
  // that most needs listing.
  const width = entries.reduce(
    (widest, entry) => Math.max(widest, entry.operation.length),
    0,
  );
  // Only "PARTIAL" and "FULL" are possible, so the wider of the two is the column.
  const badgeWidth = entries.some((e) => e.receipt.completeness === "partial")
    ? "PARTIAL".length
    : "FULL".length;

  const runs = new Set(entries.map((entry) => entry.run));
  let current: string | null = null;
  for (const entry of entries) {
    if (entry.run !== current) {
      current = entry.run;
      lines.push("", `  ${color.dim("run")} ${color.bold(entry.run)}`);
    }
    const { completeness, operation } = entry.receipt;
    const glyph = completeness === "full" ? symbol.success : symbol.error;
    // The template, because two receipts in one run can be judged against
    // different shapes, and the verdict means nothing without it.
    const title =
      operation.title === undefined ? "" : ` ${color.dim(operation.title)}`;
    lines.push(
      `    ${glyph} ${entry.operation.padEnd(width)}  ${badge(completeness, badgeWidth)}  ${color.dim(operation.template)}${title}`,
    );
  }

  const noun = entries.length === 1 ? "receipt" : "receipts";
  const across = runs.size === 1 ? "" : ` across ${runs.size} runs`;
  lines.push("", color.dim(`${entries.length} ${noun}${across}.`));

  return lines.join("\n");
}
