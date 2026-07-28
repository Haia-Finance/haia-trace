/**
 * `haia-trace template list | new` — working with the templates a receipt is
 * assembled against.
 *
 * A template is the one part of Trace a user is expected to author: the built-in
 * x402 pair covers the payment flows the adapter records, but an operation the CLI
 * has never heard of needs a shape of its own. So the command is a namespace with
 * a verb, not a bare listing — `list` says what `build --template` will accept,
 * `new` writes a starter file into the same directory `build` searches first, and
 * the two halves of that loop need no flags to meet.
 *
 * Both `run*` functions stay free of commander so they test directly, and neither
 * decides where templates live — that contract belongs to `../templates.js`.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import type { Command } from "commander";

import { isErrno } from "../fs.js";
import { renderScaffold } from "../scaffold.js";
import {
  listAllTemplates,
  listTemplates,
  TEMPLATE_NAME,
  templatePath,
  USER_TEMPLATES_DIR,
} from "../templates.js";
import { color, emoji, symbol } from "../ui.js";
import type { TraceCommand } from "./types.js";

export interface TemplateListOptions {
  /** Directory of the project's own templates. Defaults to `.trace/templates`. */
  templatesDir?: string;
}

export interface TemplateNewOptions extends TemplateListOptions {
  /** Overwrite an existing file instead of refusing. */
  force?: boolean;
}

/** Print every template `build --template` can resolve, and where each comes from. */
export function runTemplateList(options: TemplateListOptions = {}): void {
  const dir = options.templatesDir ?? USER_TEMPLATES_DIR;
  const sources = listAllTemplates(dir);

  if (sources.length === 0) {
    // The built-in directory exists (a missing one throws in the loader), so an
    // empty list means a shipping mistake worth flagging, not silence.
    console.log(
      `${symbol.warning} ${color.yellow("No operation templates are installed.")}`,
    );
    return;
  }

  console.log(`${emoji.templates} ${color.bold("Operation templates")}\n`);
  // Pad to the longest name so the origin column lines up, as the receipt
  // renderer does with stage ids.
  const width = Math.max(...sources.map((source) => source.name.length));
  for (const source of sources) {
    // A local template is shown by path, not by label: it is a file the user can
    // open, and the path is also the answer to "which one is being used?" when it
    // shadows a built-in of the same name.
    const origin = source.origin === "builtin" ? "built-in" : source.path;
    console.log(
      `  ${symbol.success} ${source.name.padEnd(width)}  ${color.dim(origin)}`,
    );
  }

  const noun = sources.length === 1 ? "template" : "templates";
  console.log(`\n${color.dim(`${sources.length} ${noun} available.`)}`);
}

/** Write a starter template and return the path written. */
export function runTemplateNew(
  name: string,
  options: TemplateNewOptions = {},
): string {
  // The same bare-slug contract the loaders use, applied at the moment of
  // creation: a name that can't be resolved later must not be writable now.
  if (!TEMPLATE_NAME.test(name)) {
    throw new Error(
      `invalid template name: ${name} — use letters, digits, "-" and "_"`,
    );
  }

  const dir = options.templatesDir ?? USER_TEMPLATES_DIR;
  const path = templatePath(dir, name);

  mkdirSync(dir, { recursive: true });
  try {
    // `wx` fails if the file exists, so the guard is the write itself — nothing
    // can slip in between a check and a clobber.
    writeFileSync(path, renderScaffold(name), {
      flag: options.force === true ? "w" : "wx",
    });
  } catch (err) {
    if (isErrno(err, "EEXIST"))
      throw new Error(
        `template already exists: ${path} — pass --force to overwrite`,
      );
    throw err;
  }

  console.log(`${symbol.success} Created ${color.bold(path)}\n`);
  if (listTemplates().includes(name)) {
    // Shadowing is allowed — it is how you adapt a shipped template — but it is
    // silent otherwise, and a surprising thing to discover from a wrong verdict.
    console.log(
      `${symbol.warning} ${color.yellow(`This shadows the built-in ${name} template.`)}\n`,
    );
  }
  // Carry the directory into the suggestion when it isn't the default one, so the
  // line printed is a command that actually resolves what was just written.
  const where =
    dir === USER_TEMPLATES_DIR ? "" : ` --templates-dir ${JSON.stringify(dir)}`;
  console.log(color.dim("  Edit the stages to match your events, then:"));
  console.log(`  haia-trace build --template ${name}${where}\n`);

  return path;
}

export const templateCommand: TraceCommand = {
  register(program: Command): void {
    const template = program
      .command("template")
      .description(
        "Work with operation templates — the shape a receipt is assembled against",
      );

    template
      .command("list")
      .description("List the templates available to build against")
      .option(
        "--templates-dir <path>",
        "directory holding the project's own templates",
        USER_TEMPLATES_DIR,
      )
      .action((opts: { templatesDir: string }) => {
        runTemplateList({ templatesDir: opts.templatesDir });
      });

    template
      .command("new")
      .argument("<name>", "name for the new template")
      .description("Scaffold a new operation template to edit")
      .option(
        "--templates-dir <path>",
        "directory to create the template in",
        USER_TEMPLATES_DIR,
      )
      .option("--force", "overwrite the file if it already exists")
      .action(
        (name: string, opts: { templatesDir: string; force?: boolean }) => {
          runTemplateNew(name, {
            templatesDir: opts.templatesDir,
            force: opts.force,
          });
        },
      );
  },
};
