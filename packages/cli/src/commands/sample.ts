/**
 * `haia-trace sample [<template>]` — the first, zero-setup taste of Trace.
 *
 * It replays a bundled set of fixture events through the *real* assembler
 * (`assembleReceipts`), the same `(events, template) → receipt` core that `build`
 * uses — the only difference from a live run is where the events come from (a
 * bundled fixture, not a recorder). The fixture set covers several
 * operations (by `context_id`) so one run shows the product's spectrum: a full
 * receipt, a partial one with an explained gap, and one with an observed fault.
 *
 * Template-neutral by construction: the template name selects both the template and
 * its fixture set, so a new scenario is data (a template file + a fixture file),
 * never a change here.
 *
 * The template is resolved exactly as `build` resolves it — a name means the same
 * file in both commands, so editing `.trace/templates/x402-buyer.yaml` changes what
 * you sample too. Only the *events* are built-in: a template with no bundled
 * fixture set has nothing to replay, and says so.
 */

import { assembleReceipts } from "@usehaia/trace-core";
import type { Command } from "commander";

import { loadFixtureEvents } from "../fixtures.js";
import { traceDirs } from "../paths.js";
import { renderReceipts } from "../render/receipt.js";
import { resolveTemplateSource } from "../templates.js";
import { color } from "../ui.js";
import { withTraceDir } from "./options.js";
import type { TraceCommand } from "./types.js";

/** The template sampled when the argument is omitted. */
const DEFAULT_TEMPLATE = "x402-buyer";

export interface SampleOptions {
  /** Root Trace directory. Defaults to `.trace`. */
  dir?: string;
  /** Directory of the project's own templates. Defaults to `<dir>/templates`. */
  templatesDir?: string;
}

/** Assemble and print the sample receipts. Separated from registration so it stays testable without commander. */
export function runSample(
  templateName: string = DEFAULT_TEMPLATE,
  options: SampleOptions = {},
): void {
  const source = resolveTemplateSource(
    templateName,
    options.templatesDir ?? traceDirs(options.dir).templates,
  );
  const events = loadFixtureEvents(templateName);
  const { receipts } = assembleReceipts(events, source.template);

  const noun = receipts.length === 1 ? "operation" : "operations";
  console.log(
    `Sampling ${color.bold(templateName)} ${color.dim("·")} ${receipts.length} ${noun} from bundled fixtures\n`,
  );
  if (source.origin !== "builtin") {
    // The events are the shipped ones but the template is not, so say whose shape
    // the verdicts below are being judged against.
    console.log(`${color.dim(`  template: ${source.path}`)}\n`);
  }

  if (receipts.length > 0) console.log(renderReceipts(receipts));
}

export const sampleCommand: TraceCommand = {
  register(program: Command): void {
    withTraceDir(
      program
        .command("sample")
        .argument(
          "[template]",
          "operation template to sample",
          DEFAULT_TEMPLATE,
        ),
    )
      .option(
        "--templates-dir <path>",
        "directory holding the project's own templates (overrides --dir)",
      )
      .description(
        "Assemble receipts from bundled fixtures — the first, zero-setup taste of Trace",
      )
      .action(
        (template: string, opts: { dir: string; templatesDir?: string }) =>
          runSample(template, {
            dir: opts.dir,
            templatesDir: opts.templatesDir,
          }),
      );
  },
};
