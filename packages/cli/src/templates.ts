/**
 * Loading operation templates — the CLI's bridge from a template *file* to the
 * `OperationTemplate` object the core assembler consumes.
 *
 * The filesystem and YAML parsing live here, not in core: core is deliberately
 * runtime-agnostic and dependency-free, and takes a template object as an
 * argument. Validation is delegated to `assertOperationTemplate` in core so the
 * contract is enforced in exactly one place.
 *
 * A template comes from one of two places. The **built-in** set ships inside this
 * package (`packages/cli/templates/`) and is carried into the published tarball by
 * the `files` list, so every install has it without a network fetch. A project's
 * **own** templates live in a directory the caller names — `templates/` under the
 * Trace root, per `./paths.js` — authored by the user, resolved first, and free to
 * shadow a built-in name. That directory is always an argument here: a default
 * would let a lookup land in `.trace/templates` while `--dir` pointed elsewhere.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertOperationTemplate,
  type OperationTemplate,
} from "@usehaia/trace-core";
import { parse } from "yaml";

import { isErrno } from "./fs.js";

const TEMPLATE_EXT = ".yaml";

/**
 * A template is referenced by a bare slug — letters, digits, `-`, `_`. This is the
 * single contract for what counts as a template *name*: it gates what `loadTemplate`
 * will load, what the listings surface, and what `template new` will create, so they
 * can never disagree (every listed name is loadable). It is also what makes a name
 * safe to join onto a directory — no separators, no `..`.
 *
 * `resolveTemplate` reads the same rule from the other side: a reference that is
 * *not* a bare slug isn't a name at all, so it must be a path.
 */
export const TEMPLATE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * The directory of built-in templates. Resolved relative to this module so the
 * same path works in dev (`src/`), after build (`dist/`), and once installed —
 * each is one level below the package root, next to a sibling `templates/`.
 */
const BUILTIN_TEMPLATES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

/**
 * Where a resolved template came from — the project's own directory, the built-in
 * set, or an explicit path the caller gave instead of a name.
 */
export type TemplateOrigin = "builtin" | "local" | "file";

/** A template the CLI can resolve by name, and where it would be loaded from. */
export interface TemplateSource {
  name: string;
  path: string;
  origin: TemplateOrigin;
}

/**
 * The file a template name maps to in a directory. The one place that mapping is
 * written down, so a listing can never name a file the resolver wouldn't read.
 */
export function templatePath(dir: string, name: string): string {
  return join(dir, `${name}${TEMPLATE_EXT}`);
}

/**
 * Whether a path is a readable regular file. Anything else — absent, a directory,
 * an unreadable entry — is "not a template here", which is what both the listings
 * and the shadowing probe need to decide.
 */
function isTemplateFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The loadable template names in a directory, sorted. */
function listDir(dir: string): string[] {
  return (
    readdirSync(dir)
      .filter((file) => file.endsWith(TEMPLATE_EXT))
      .map((file) => file.slice(0, -TEMPLATE_EXT.length))
      // Surface only names that can actually be loaded — the same bare-slug
      // contract — so enumerating and then loading by the listed name never
      // disagree. A `.yaml` whose base name isn't a slug (a `.`, a space) isn't a
      // referenceable template, so it is not listed.
      .filter((name) => TEMPLATE_NAME.test(name))
      // A directory called `archive.yaml` is not a template, however much its name
      // looks like one — listing it would promise a load that fails with EISDIR.
      .filter((name) => isTemplateFile(templatePath(dir, name)))
      .sort((a, b) => a.localeCompare(b))
  );
}

/** Names of the templates shipped with the CLI, sorted — e.g. `["x402-buyer", "x402-seller"]`. */
export function listTemplates(): string[] {
  try {
    return listDir(BUILTIN_TEMPLATES_DIR);
  } catch (err) {
    // A missing built-in templates directory means a broken install, not "none".
    if (isErrno(err, "ENOENT"))
      throw new Error(
        `templates directory not found: ${BUILTIN_TEMPLATES_DIR}`,
      );
    throw err;
  }
}

/**
 * Names of the project's own templates, sorted. An absent directory is the normal
 * case — most projects author none — so it reads as an empty list, the opposite of
 * the built-in directory, whose absence is a broken install.
 */
export function listLocalTemplates(dir: string): string[] {
  try {
    return listDir(dir);
  } catch (err) {
    // Absent, or present but not a directory: either way the project has no
    // templates here, which is the normal case and not worth an error.
    if (isErrno(err, "ENOENT") || isErrno(err, "ENOTDIR")) return [];
    throw err;
  }
}

/**
 * Every template addressable by name, sorted, each labelled with the file
 * `resolveTemplate` would actually load.
 *
 * The origin is decided by asking the filesystem the same question the resolver
 * asks — is there a file at this name in the project directory? — rather than by
 * comparing name strings. On a case-insensitive filesystem those two answers
 * differ: a local `X402-Buyer.yaml` also answers to `x402-buyer`, and a listing
 * that compared strings would call that name built-in while `build` loaded the
 * local file.
 */
export function listAllTemplates(dir: string): TemplateSource[] {
  const names = [
    ...new Set([...listLocalTemplates(dir), ...listTemplates()]),
  ].sort((a, b) => a.localeCompare(b));

  return names.map((name) => {
    const local = templatePath(dir, name);
    return isTemplateFile(local)
      ? { name, path: local, origin: "local" as const }
      : {
          name,
          path: templatePath(BUILTIN_TEMPLATES_DIR, name),
          origin: "builtin" as const,
        };
  });
}

/**
 * Read and parse a template if the file exists, else `null`.
 *
 * Only a genuinely absent file is `null`. A present-but-broken one — bad YAML, a
 * failed contract, unreadable — throws, so a malformed local template can never
 * fall through and be silently replaced by the built-in of the same name.
 */
function readTemplateIfPresent(
  path: string,
  source: string,
): OperationTemplate | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw new Error(
      `could not read template (${source}): ${(err as Error).message}`,
    );
  }
  return parseTemplate(text, source);
}

/**
 * Resolve a `--template` reference the way `build` does: the project's own
 * templates first, then the built-in set.
 *
 * A reference that isn't a bare slug can't be a template *name*, so it is taken as
 * a path — `./ops/refund.yaml`, an absolute path, anything with a separator or a
 * dot. That keeps one rule for both forms, and leaves the name path unable to reach
 * outside the directories it is joined onto.
 */
export function resolveTemplate(ref: string, dir: string): OperationTemplate {
  return resolveTemplateSource(ref, dir).template;
}

/**
 * `resolveTemplate`, plus the file it came from.
 *
 * Which of two same-named templates won is invisible in the assembled receipt —
 * it records the template's declared name, not its provenance — so a caller that
 * shows a verdict to someone should say which file produced it.
 */
export function resolveTemplateSource(
  ref: string,
  dir: string,
): TemplateSource & { template: OperationTemplate } {
  if (!TEMPLATE_NAME.test(ref)) {
    return {
      name: ref,
      path: ref,
      origin: "file",
      template: loadTemplateFile(ref),
    };
  }

  // A project template reports as its path, not its name: when it fails to load,
  // the file to open is the useful half of the message, and it also says which of
  // the two `${ref}` templates was the one that broke.
  const localPath = templatePath(dir, ref);
  const local = readTemplateIfPresent(localPath, localPath);
  if (local !== null)
    return { name: ref, path: localPath, origin: "local", template: local };

  const builtinPath = templatePath(BUILTIN_TEMPLATES_DIR, ref);
  const builtin = readTemplateIfPresent(builtinPath, ref);
  if (builtin !== null)
    return {
      name: ref,
      path: builtinPath,
      origin: "builtin",
      template: builtin,
    };

  // Name both places searched: "not found" is nearly always a typo or a template
  // saved somewhere else, and neither is diagnosable from the name alone.
  throw new Error(
    `template not found: ${ref} (looked in ${dir}, then the templates shipped with the CLI)`,
  );
}

/** Load a built-in template by name. Throws if the name is unknown or the file is malformed. */
export function loadTemplate(name: string): OperationTemplate {
  // Only a bare slug can name a template; reject anything with path separators or
  // `..` before it reaches the join, so a name cannot escape the templates
  // directory. Such a name is simply an unknown template.
  if (!TEMPLATE_NAME.test(name)) throw new Error(`template not found: ${name}`);
  return loadTemplateFile(templatePath(BUILTIN_TEMPLATES_DIR, name), name);
}

/**
 * Load a template from an explicit path — also the entry point for a
 * user-authored template outside the built-in set. `name` only shapes error
 * messages; it defaults to the path.
 */
export function loadTemplateFile(
  path: string,
  name?: string,
): OperationTemplate {
  const source = name ?? path;
  const template = readTemplateIfPresent(path, source);
  if (template === null) throw new Error(`template not found: ${source}`);
  return template;
}

/** Parse and validate template YAML text into an `OperationTemplate`. */
export function parseTemplate(
  text: string,
  source = "<inline>",
): OperationTemplate {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (err) {
    // Attach the source so a YAML syntax error names which template failed.
    throw new Error(`invalid template (${source}): ${(err as Error).message}`);
  }
  return assertOperationTemplate(parsed, source);
}
