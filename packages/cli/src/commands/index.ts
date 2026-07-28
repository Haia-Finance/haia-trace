/**
 * The command registry — the single list `cli.ts` walks to build the program.
 *
 * Adding a command is a two-line change: import its `TraceCommand` and append it
 * here. Order here is the order commands appear in `haia-trace --help`.
 */

import { buildCommand } from "./build.js";
import { sampleCommand } from "./sample.js";
import { templateCommand } from "./template.js";
import type { TraceCommand } from "./types.js";

export const commands: TraceCommand[] = [
  buildCommand,
  sampleCommand,
  templateCommand,
];

export type { TraceCommand } from "./types.js";
