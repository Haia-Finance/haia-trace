/**
 * Options shared by more than one command, so a flag means exactly one thing
 * wherever it appears.
 */

import type { Receipt } from "@usehaia/trace-core";
import type { Command } from "commander";

import { DEFAULT_TRACE_DIR } from "../paths.js";

/**
 * Add `--dir`, the root every other Trace path hangs off.
 *
 * Registered per subcommand rather than on the program, so it reads in the order
 * people type — `haia-trace build --dir .my-trace`. A program-level copy would
 * mean two sources for one value and merge logic to reconcile them.
 */
export function withTraceDir(command: Command): Command {
  return command.option(
    "--dir <path>",
    "root directory holding events, receipts and templates",
    DEFAULT_TRACE_DIR,
  );
}

/**
 * A receipt verdict a `--status` flag can carry — the core Receipt contract's
 * `completeness` values, aliased rather than restated so the flag cannot drift
 * from the verdicts receipts actually hold.
 */
export type Status = Receipt["completeness"];

/** The verdicts a `--status` filter can name — shared by `build` and `receipt list`. */
export const STATUSES = [
  "full",
  "partial",
] as const satisfies readonly Status[];

/**
 * Refuse a status that is not a verdict. Commander does not validate the value of
 * `--status <full|partial>`, and the `run*` functions are also called directly,
 * so the check lives with the value rather than being repeated per command.
 * Takes the raw string so an unvalidated value flows in without a cast, and
 * narrows it for whatever follows the call.
 */
export function checkStatus(
  status: string | undefined,
): asserts status is Status | undefined {
  if (status !== undefined && !STATUSES.some((valid) => valid === status)) {
    throw new Error(
      `invalid status: ${status} — expected ${STATUSES.join(" or ")}`,
    );
  }
}
