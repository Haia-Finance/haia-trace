/**
 * Options shared by more than one command, so a flag means exactly one thing
 * wherever it appears.
 */

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
