/**
 * The presentation layer — the one place the CLI reaches for terminal styling, so
 * every command draws from the same small, deliberate toolkit rather than
 * importing colour/symbol libraries ad hoc.
 *
 * The stack is intentionally minimal and auditable (the repo's trust guarantee):
 * `picocolors` (zero-dep colours), `log-symbols` (status glyphs that fall back to
 * ASCII where Unicode is unsupported), and `nanospinner` (a spinner for genuinely
 * long-running work — chain queries, anchoring — never for instant output).
 *
 * Emoji are plain Unicode strings, not a dependency; a couple used across
 * commands live here so their meaning stays consistent.
 */

import symbols from "log-symbols";
import { createSpinner } from "nanospinner";
import pc from "picocolors";

/** Colour helpers — re-exported so commands import styling from one module. */
export const color = pc;

/**
 * Status glyphs (`✔ ✖ ℹ ⚠`), already ASCII-safe via `log-symbols`. These map onto
 * the states a receipt stage can be in, so terminal output speaks the same visual
 * language as the product model.
 */
export const symbol = symbols;

/** Emoji used across commands, named so their intent is explicit at the call site. */
export const emoji = {
  templates: "📋",
  receipt: "🧾",
  money: "💸",
  chain: "🔗",
} as const;

/**
 * A spinner for long-running work. Thin wrapper over `nanospinner` so commands
 * don't import it directly and the presentation stack stays swappable.
 *
 * Use only for real asynchronous work; a spinner on instant output would fake
 * progress, which this tool must never do.
 */
export function spinner(text: string) {
  return createSpinner(text);
}
