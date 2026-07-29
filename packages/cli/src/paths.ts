/**
 * The Trace directory layout — the one module that knows where things live.
 *
 * Everything Trace reads and writes sits under a single root, `.trace/` by
 * default and relocatable with `--dir`. What is *inside* that root is fixed:
 * `events/`, `receipts/`, `templates/`. Fixing the layout is what makes the root
 * relocatable at all — one flag moves the whole thing, and a relocated root is
 * still self-describing to whoever opens it next.
 *
 * The layout lives here rather than in core: core describes events and assembles
 * receipts, and is handed every path it touches. It is not repeated in the
 * modules that consume it either — `store.ts`, `templates.ts` and the commands
 * all take directories as required arguments, so none of them can quietly fall
 * back to `.trace/...` while `--dir` says otherwise.
 */

import { join } from "node:path";

/** The root when `--dir` is not given, relative to the working directory. */
export const DEFAULT_TRACE_DIR = ".trace";

/** The directories under a Trace root. */
export interface TraceDirs {
  /** The root itself. */
  root: string;
  /** Append-only run files, `<run>.ndjson` — the source of truth. */
  events: string;
  /** Assembled receipts, `<run>~<operation>.json` — derived, rebuildable. */
  receipts: string;
  /**
   * The project's own operation templates. Beside the other two, but unlike them
   * this is *source*: authored by the user and worth committing, which is why it
   * also has a flag of its own (`--templates-dir`) that outranks `--dir`.
   */
  templates: string;
}

/**
 * The directories under `root`, defaulting to `.trace/`.
 *
 * An *absent* root takes the default; an empty one is refused rather than
 * quietly joined. `--dir "$TRACE_ROOT"` with the variable unset arrives here as
 * `""`, and `join("", "templates")` is `"templates"` — the whole layout would
 * land loose in the working directory, outside the `.trace/…` entries the
 * gitignore guidance covers. Falling back to the default instead would be just
 * as wrong in the other direction: it would build against a root the caller
 * never named.
 */
export function traceDirs(root: string = DEFAULT_TRACE_DIR): TraceDirs {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error(
      "the Trace root must be a non-empty path — check the value passed to --dir",
    );
  }

  return {
    root,
    events: join(root, "events"),
    receipts: join(root, "receipts"),
    templates: join(root, "templates"),
  };
}
