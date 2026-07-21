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
 * The directory of shipped templates. Resolved relative to this module so the
 * same path works in dev (`src/`), after build (`dist/`), and once installed —
 * each is one level below the package root, next to a sibling `templates/`.
 */
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

/** Names of the templates shipped with the CLI, sorted — e.g. `["x402-payment"]`. */
export function listTemplates(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith(TEMPLATE_EXT))
    .map((file) => file.slice(0, -TEMPLATE_EXT.length))
    .sort();
}

/** Load a shipped template by name. Throws if the name is unknown or the file is malformed. */
export function loadTemplate(name: string): OperationTemplate {
  return loadTemplateFile(join(TEMPLATES_DIR, `${name}${TEMPLATE_EXT}`), name);
}

/**
 * Load a template from an explicit path — also the entry point for a
 * user-authored template outside the shipped set. `name` only shapes error
 * messages; it defaults to the path.
 */
export function loadTemplateFile(path: string, name?: string): OperationTemplate {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`template not found: ${name ?? path}`);
  }
  return parseTemplate(text, name ?? path);
}

/** Parse and validate template YAML text into an `OperationTemplate`. */
export function parseTemplate(text: string, source = "<inline>"): OperationTemplate {
  return assertOperationTemplate(parse(text), source);
}
