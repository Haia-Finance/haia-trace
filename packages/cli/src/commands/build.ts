/**
 * `haia-trace build [<file>] [--template <id>] [--json]` — the core "assemble on
 * request" command: read a run's events and produce one Receipt per operation.
 *
 * `sample` / `last` / `rerun` are special cases of this — same events + template
 * through the same core. Events are the source of truth; a receipt is derived and
 * reproducible: the same ndjson yields byte-identical receipts (BR-4).
 *
 * It splits the run by `context_id` and folds each operation through the core with
 * `assembleReceiptsProgressively`, which streams progress so a large run never
 * looks hung. Run-level events with no `context_id` (attestations, chain
 * confirmations) belong to no single operation, so they are surfaced separately
 * rather than attributed or dropped — the seed of the receipt's future `capture`
 * block, which the receipt model does not carry yet.
 */

import { join } from "node:path";

import type { Command } from "commander";

import {
  assembleReceiptsProgressively,
  type Receipt,
  type RunProgress,
  type TraceEvent,
} from "@usehaia/trace-core";
import { createFileReader, readLatestRun } from "@usehaia/trace-core/node";

import { renderReceipt } from "../render/receipt.js";
import { RECEIPTS_DIR, writeReceipt } from "../store.js";
import { loadTemplate } from "../templates.js";
import { color, spinner } from "../ui.js";
import type { TraceCommand } from "./types.js";

/** The template applied when `--template` is omitted. */
const DEFAULT_TEMPLATE = "x402-payment";

/** Default run-events directory, relative to the working directory. */
const EVENTS_DIR = join(".trace", "events");

export interface BuildOptions {
  /** Template id to apply to every operation in the run. Defaults to `x402-payment`. */
  template?: string;
  /** Emit machine-readable JSON instead of a terminal summary. */
  json?: boolean;
  /** Run-events directory to resolve the latest run from when no file is given. */
  eventsDir?: string;
  /** Directory receipts are written to. */
  receiptsDir?: string;
}

/** The build result — one receipt per operation, plus the run-level events attributed to none. */
export interface BuildResult {
  receipts: Receipt[];
  unassigned: TraceEvent[];
}

/** Assemble the run's receipts, write them, and report. Separated from registration so it stays testable. */
export function runBuild(file: string | undefined, options: BuildOptions = {}): BuildResult {
  const templateName = options.template ?? DEFAULT_TEMPLATE;
  const json = options.json ?? false;
  const eventsDir = options.eventsDir ?? EVENTS_DIR;
  const receiptsDir = options.receiptsDir ?? RECEIPTS_DIR;

  // An explicit path wins; otherwise build the latest run in the events dir.
  const reader = file !== undefined ? createFileReader(file) : readLatestRun(eventsDir);
  if (reader === null) {
    throw new Error(`no runs found in ${eventsDir} — run under the recorder or pass a run file`);
  }
  const events = reader.read();
  const template = loadTemplate(templateName);

  // Only spin on an interactive terminal: a spinner in piped or machine output is
  // noise, and JSON output must stay pure.
  const spin = !json && process.stdout.isTTY ? spinner("Assembling receipts…").start() : null;

  // Drive the assembler progressively for a live progress count; the final
  // snapshot holds the finished receipts.
  let last: RunProgress = { processed: 0, total: 0, receipts: [], unassigned: [] };
  for (const progress of assembleReceiptsProgressively(events, template)) {
    last = progress;
    spin?.update({ text: `Assembling receipts… ${progress.processed}/${progress.total} events` });
  }
  const { receipts, unassigned } = last;

  // Persist every receipt regardless of output format — writing is the store
  // layer's job, independent of what the terminal shows.
  for (const receipt of receipts) writeReceipt(receipt, receiptsDir);

  const noun = receipts.length === 1 ? "receipt" : "receipts";
  spin?.success({ text: `Assembled ${receipts.length} ${noun} from ${last.total} events` });

  if (json) {
    process.stdout.write(`${JSON.stringify({ receipts, unassigned }, null, 2)}\n`);
    return { receipts, unassigned };
  }

  console.log("");
  receipts.forEach((receipt, index) => {
    if (index > 0) console.log(color.dim("  ────────────────────────────"));
    console.log(renderReceipt(receipt));
    console.log("");
  });
  if (receipts.length === 0) {
    console.log(color.yellow("  no operations found in this run"));
  }
  if (unassigned.length > 0) {
    const evNoun = unassigned.length === 1 ? "event" : "events";
    console.log(color.dim(`  ${unassigned.length} run-level ${evNoun} not attributed to any operation`));
  }

  return { receipts, unassigned };
}

export const buildCommand: TraceCommand = {
  register(program: Command): void {
    program
      .command("build")
      .argument("[file]", "ndjson run file to build from (default: the latest in .trace/events)")
      .option("--template <id>", "operation template to apply to every operation", DEFAULT_TEMPLATE)
      .option("--json", "emit machine-readable JSON instead of a terminal summary")
      .description("Assemble one receipt per operation from a run's events")
      .action((file: string | undefined, opts: { template: string; json?: boolean }) => {
        runBuild(file, { template: opts.template, json: opts.json });
      });
  },
};
