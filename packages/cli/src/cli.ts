#!/usr/bin/env node
/**
 * The `trace` executable — the CLI entry point named by the package's `bin`.
 *
 * Deliberately thin: it builds the root program, registers every command from the
 * registry, and parses argv. All behaviour lives in `./commands/*`, so this file
 * almost never changes as commands are added — the scaffold's whole point.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { commands } from "./commands/index.js";
import { color } from "./ui.js";

/**
 * Read the CLI version from the package manifest at runtime, so it has one source
 * of truth. The manifest sits at the package root, one level above this module in
 * both `src/` (dev) and `dist/` (built) — and outside `rootDir`, which is why it's
 * read here rather than imported.
 */
function readVersion(): string {
  const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(readFileSync(manifest, "utf8")).version as string;
}

const program = new Command();

program
  .name("trace")
  .description("Haia Trace — build an Operation Receipt for a payment operation.")
  .version(readVersion(), "-v, --version", "Print the version and exit");

for (const command of commands) {
  command.register(program);
}

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // A last-resort net so an unhandled command error prints a clean line and a
  // non-zero exit, instead of a raw stack trace.
  console.error(`${color.red("error:")} ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
