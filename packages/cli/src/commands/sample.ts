/**
 * `haia-trace sample [<template>]` — the first, zero-setup taste of Trace.
 *
 * It replays a bundled set of fixture events through the *real* assembler
 * (`assembleReceipts`), the same `(events, template) → receipt` core that `build`
 * and `last` use — the only difference from a live run is where the events come
 * from (a bundled fixture, not a recorder). The fixture set covers several
 * operations (by `context_id`) so one run shows the product's spectrum: a full
 * receipt, a partial one with an explained gap, and one with an observed fault.
 *
 * Template-neutral by construction: the template name selects both the template and
 * its fixture set, so a new scenario is data (a template file + a fixture file),
 * never a change here.
 */

import { assembleReceipts } from "@usehaia/trace-core";
import type { Command } from "commander";

import { loadFixtureEvents } from "../fixtures.js";
import { renderReceipt } from "../render/receipt.js";
import { loadTemplate } from "../templates.js";
import { color } from "../ui.js";
import type { TraceCommand } from "./types.js";

/** The template sampled when the argument is omitted. */
const DEFAULT_TEMPLATE = "x402-payment";

/** Assemble and print the sample receipts. Separated from registration so it stays testable without commander. */
export function runSample(templateName: string = DEFAULT_TEMPLATE): void {
  const template = loadTemplate(templateName);
  const events = loadFixtureEvents(templateName);
  const { receipts } = assembleReceipts(events, template);

  const noun = receipts.length === 1 ? "operation" : "operations";
  console.log(
    `Sampling ${color.bold(templateName)} ${color.dim("·")} ${receipts.length} ${noun} from bundled fixtures\n`,
  );

  receipts.forEach((receipt, index) => {
    if (index > 0) console.log(color.dim("  ────────────────────────────"));
    console.log(renderReceipt(receipt));
    console.log("");
  });
}

export const sampleCommand: TraceCommand = {
  register(program: Command): void {
    program
      .command("sample")
      .argument("[template]", "operation template to sample", DEFAULT_TEMPLATE)
      .description(
        "Assemble receipts from bundled fixtures — the first, zero-setup taste of Trace",
      )
      .action((template: string) => runSample(template));
  },
};
