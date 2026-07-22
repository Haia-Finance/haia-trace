/**
 * Loading operation templates — the CLI's bridge from a template *file* to the
 * `OperationTemplate` object the core assembler consumes.
 *
 * The filesystem and YAML parsing live here, not in core: core is deliberately
 * runtime-agnostic and dependency-free, and takes a template object as an
 * argument. Validation is delegated to `assertOperationTemplate` in core so the
 * contract is enforced in exactly one place.
 *
 * The built-in templates ship inside this package (`packages/cli/templates/`) and
 * are carried into the published tarball by the `files` list, so every install
 * has them without a network fetch.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { assertOperationTemplate, type OperationTemplate } from "@usehaia/trace-core";

const TEMPLATE_EXT = ".yaml";

/**
 * A shipped template is referenced by a bare slug — letters, digits, `-`, `_`.
 * This is the single contract for what counts as a shipped template name: it
 * gates both what `loadTemplate` will load and what `listTemplates` surfaces, so
 * the two can never disagree (every listed name is loadable).
 */
const TEMPLATE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * The directory of shipped templates. Resolved relative to this module so the
 * same path works in dev (`src/`), after build (`dist/`), and once installed —
 * each is one level below the package root, next to a sibling `templates/`.
 */
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

/** Whether an error is a Node filesystem error carrying the given `code`. */
function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

/** Names of the templates shipped with the CLI, sorted — e.g. `["x402-payment"]`. */
export function listTemplates(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(TEMPLATES_DIR);
  } catch (err) {
    // A missing shipped-templates directory means a broken install, not "none".
    if (isErrno(err, "ENOENT")) throw new Error(`templates directory not found: ${TEMPLATES_DIR}`);
    throw err;
  }
  return entries
    .filter((file) => file.endsWith(TEMPLATE_EXT))
    .map((file) => file.slice(0, -TEMPLATE_EXT.length))
    // Surface only names that `loadTemplate` can actually load — the same
    // bare-slug contract — so enumerating and then loading by the listed name
    // never disagree. A shipped `.yaml` whose base name isn't a slug (a `.`, a
    // space) isn't a referenceable template, so it is not listed.
    .filter((name) => TEMPLATE_NAME.test(name))
    .sort();
}

/** Load a shipped template by name. Throws if the name is unknown or the file is malformed. */
export function loadTemplate(name: string): OperationTemplate {
  // Only a bare slug can name a shipped template; reject anything with path
  // separators or `..` before it reaches the join, so a name cannot escape the
  // templates directory. Such a name is simply an unknown template.
  if (!TEMPLATE_NAME.test(name)) throw new Error(`template not found: ${name}`);
  return loadTemplateFile(join(TEMPLATES_DIR, `${name}${TEMPLATE_EXT}`), name);
}

/**
 * Load a template from an explicit path — also the entry point for a
 * user-authored template outside the shipped set. `name` only shapes error
 * messages; it defaults to the path.
 */
export function loadTemplateFile(path: string, name?: string): OperationTemplate {
  const source = name ?? path;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // Only a genuinely absent file is "not found"; a present-but-unreadable file
    // (permissions, a directory) must report the real error, not a false absence.
    if (isErrno(err, "ENOENT")) throw new Error(`template not found: ${source}`);
    throw new Error(`could not read template (${source}): ${(err as Error).message}`);
  }
  return parseTemplate(text, source);
}

/** Parse and validate template YAML text into an `OperationTemplate`. */
export function parseTemplate(text: string, source = "<inline>"): OperationTemplate {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (err) {
    // Attach the source so a YAML syntax error names which template failed.
    throw new Error(`invalid template (${source}): ${(err as Error).message}`);
  }
  return assertOperationTemplate(parsed, source);
}
