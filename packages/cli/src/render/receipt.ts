/**
 * Terminal renderer for a Receipt — the product's core surface: it states
 * "status / gaps", never a list of events.
 *
 * This is the "not a log viewer" guarantee in code (BR-7). The renderer shows each
 * milestone's verdict, the required gaps with their plain-language meaning, and the
 * faults observed — and deliberately never prints `receipt.events`. Kept as its own
 * module because every command that shows a receipt (`sample` now, `build` / `last`
 * next) renders through this one function.
 *
 * Returns a string rather than printing, so callers control output and tests can
 * assert on it.
 */

import type { Receipt } from "@usehaia/trace-core";

import { color, emoji, symbol } from "../ui.js";

/** The completeness verdict as a coloured badge: green for a clean full, yellow otherwise. */
function badge(completeness: Receipt["completeness"]): string {
  return completeness === "full"
    ? color.bold(color.green("FULL"))
    : color.bold(color.yellow("PARTIAL"));
}

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
      lines.push(`  ${symbol.error} ${id}  ${color.red("not confirmed")}  ${color.dim("required")}`);
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
      const detail = m.why ?? `expected one of: ${m.expected_events.join(", ")}`;
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
