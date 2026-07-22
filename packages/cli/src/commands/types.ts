/**
 * The command contract — the one shape every `trace` sub-command implements, and
 * the seam that keeps "add a new command" a one-file change.
 *
 * A command owns its own registration: it declares its name, description,
 * arguments, options, and action against the root program. The registry
 * (`./index.ts`) only collects them; `cli.ts` only iterates and wires. To add a
 * command, write one file exporting a `TraceCommand` and add it to the registry —
 * nothing in `cli.ts` changes.
 */

import type { Command } from "commander";

export interface TraceCommand {
  /**
   * Attach this command to the root program — its name, description, arguments,
   * options, and action. Receives the root `Command` so a command can also nest
   * its own sub-commands later without changing this contract.
   */
  register(program: Command): void;
}
