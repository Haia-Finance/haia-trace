/**
 * `trace templates` — list the operation templates shipped with the CLI.
 *
 * The first real command, and the scaffold's proof of wiring: it exercises the
 * full path from `bin` → argv parsing → command → core-backed data
 * (`listTemplates`) → styled output, without needing the not-yet-built receipt
 * assembler. Real behaviour, not a stub.
 */

import type { Command } from "commander";

import { listTemplates } from "../templates.js";
import { color, emoji, symbol } from "../ui.js";
import type { TraceCommand } from "./types.js";

/** Print the shipped templates. Separated from registration so it stays testable without commander. */
export function runTemplates(): void {
  const names = listTemplates();

  if (names.length === 0) {
    // The templates directory exists (a missing one throws in the loader), so an
    // empty list means a shipping mistake worth flagging, not silence.
    console.log(
      `${symbol.warning} ${color.yellow("No operation templates are installed.")}`,
    );
    return;
  }

  console.log(
    `${emoji.templates} ${color.bold("Operation templates shipped with the CLI:")}\n`,
  );
  for (const name of names) {
    console.log(`  ${symbol.success} ${name}`);
  }
  const noun = names.length === 1 ? "template" : "templates";
  console.log(`\n${color.dim(`${names.length} ${noun} available.`)}`);
}

export const templatesCommand: TraceCommand = {
  register(program: Command): void {
    program
      .command("templates")
      .description("List the operation templates shipped with the CLI")
      .action(runTemplates);
  },
};
