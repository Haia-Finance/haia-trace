/**
 * `haia-trace build [<file>...] [--all] [--template <id>] [--json]` — the core
 * "assemble on request" command: read a run's events and produce one Receipt per
 * operation.
 *
 * `sample` / `last` / `rerun` are special cases of this — same events + template
 * through the same core. Events are the source of truth; a receipt is derived and
 * reproducible: the same ndjson yields byte-identical receipts (BR-4).
 *
 * It splits each run by `context_id` and folds every operation through the core:
 * with a terminal to draw on, through `assembleReceiptsProgressively`, so a large
 * run never looks hung; otherwise through the eager `assembleReceipts`, whose
 * result the progressive one is defined to end at. Run-level events with no
 * `context_id` (attestations, chain
 * confirmations) belong to no single operation, so they are surfaced separately
 * rather than attributed or dropped — the seed of the receipt's future `capture`
 * block, which the receipt model does not carry yet.
 *
 * More than one run is more than one *build*, never one merged event set: events
 * carry no run id and `context_id` is only unique within a run, so concatenating
 * two runs would fold two unrelated payments that both happen to be called `op-1`
 * into a single receipt. Every run is therefore read, assembled and reported on
 * its own, and its receipts are stored under its run id.
 */

import { resolve } from "node:path";

import {
  assembleReceipts,
  assembleReceiptsProgressively,
  type Receipt,
  type RunProgress,
  type TraceEvent,
} from "@usehaia/trace-core";
import {
  createFileReader,
  listRunFiles,
  runIdFromPath,
} from "@usehaia/trace-core/node";
import type { Command } from "commander";

import { traceDirs } from "../paths.js";
import { renderReceipt } from "../render/receipt.js";
import { writeReceipt } from "../store.js";
import { resolveTemplateSource, type TemplateSource } from "../templates.js";
import { color, spinner } from "../ui.js";
import { withTraceDir } from "./options.js";
import type { TraceCommand } from "./types.js";

/** The template applied when `--template` is omitted. */
const DEFAULT_TEMPLATE = "x402-buyer";

export interface BuildOptions {
  /**
   * Template to apply to every operation in the run — a name resolved against the
   * project's templates and then the built-in set, or a path to a template file.
   * Defaults to `x402-buyer`.
   */
  template?: string;
  /** Root directory the three below hang off. Defaults to `.trace`. */
  dir?: string;
  /** Directory of the project's own templates. Defaults to `<dir>/templates`. */
  templatesDir?: string;
  /** Emit machine-readable JSON instead of a terminal summary. */
  json?: boolean;
  /** Build every run in the events directory instead of only the latest. */
  all?: boolean;
  /** Run-events directory to resolve runs from when no file is given. Defaults to `<dir>/events`. */
  eventsDir?: string;
  /** Directory receipts are written to. Defaults to `<dir>/receipts`. */
  receiptsDir?: string;
}

/** What one run yielded — one receipt per operation, plus the events attributed to none. */
export interface BuiltRun {
  /** The run id: the run file's name without its extension. */
  run: string;
  /** The run file the receipts were assembled from. */
  path: string;
  receipts: Receipt[];
  unassigned: TraceEvent[];
}

/** The build result — what each run yielded, and the template they were judged against. */
export interface BuildResult {
  /**
   * One entry per run built — explicitly named files in the order they were
   * given, runs taken from the events directory oldest first. Receipts are
   * nested per run rather than flattened because `operation_id` is only unique
   * within its run: a flat list can hold two different payments both called
   * `op-1`.
   */
  runs: BuiltRun[];
  /**
   * The template the verdicts were assembled against, and the file it came from. A
   * receipt records the template's declared name but not which file declared it, so
   * two runs of the same command can differ purely because one machine has a
   * `.trace/templates/` override. Reporting the path makes that visible.
   */
  template: TemplateSource;
}

/**
 * The run files to build. Explicit paths win and keep the order they were given
 * in — a glob expands to them already sorted, and re-sorting would quietly
 * override an order the caller chose. Otherwise the events directory supplies
 * either every run or just the newest one, oldest first.
 *
 * The same file named twice — a glob plus one of its own members — is built
 * once: it is one run, and building it twice would double-count its operations
 * in the summary and in `--json`.
 */
function selectRuns(
  files: string[],
  all: boolean,
  eventsDir: string,
): string[] {
  if (files.length > 0) {
    if (all) {
      throw new Error(
        "--all selects runs from the events directory — drop it when passing run files",
      );
    }
    const seen = new Set<string>();
    // Compared as resolved paths, so `./run.ndjson` and `run.ndjson` count once.
    return files.filter((file) => {
      const key = resolve(file);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const runs = listRunFiles(eventsDir);
  if (runs.length === 0) {
    throw new Error(
      `no runs found in ${eventsDir} — run under the recorder or pass a run file`,
    );
  }
  return all ? runs : runs.slice(-1);
}

/**
 * The run id of every selected path, refusing a selection in which two files
 * share one. A run id is a file *name*, so `a/run.ndjson` and `b/run.ndjson` are
 * both `run`, and their receipts would land on the same files — the second
 * silently overwriting the first while the report claimed both were built.
 * Refusing costs the caller one command per directory; the alternative loses a
 * receipt.
 */
function runIdsOf(paths: string[]): string[] {
  const byId = new Map<string, string>();
  return paths.map((path) => {
    const id = runIdFromPath(path);
    const first = byId.get(id);
    if (first !== undefined) {
      throw new Error(
        `two run files are both named "${id}" (${first} and ${path}) — receipts are keyed by run name, so build them separately or rename one`,
      );
    }
    byId.set(id, path);
    return id;
  });
}

/** Assemble each run's receipts, write them, and report. Separated from registration so it stays testable. */
export function runBuild(
  files: string[] = [],
  options: BuildOptions = {},
): BuildResult {
  const templateName = options.template ?? DEFAULT_TEMPLATE;
  const json = options.json ?? false;
  // `--dir` moves the root; a narrower directory, when given, outranks it.
  const dirs = traceDirs(options.dir);
  const templatesDir = options.templatesDir ?? dirs.templates;
  const eventsDir = options.eventsDir ?? dirs.events;
  const receiptsDir = options.receiptsDir ?? dirs.receipts;

  const paths = selectRuns(files, options.all ?? false, eventsDir);
  const ids = runIdsOf(paths);
  const { template, ...source } = resolveTemplateSource(
    templateName,
    templatesDir,
  );

  // Only spin on an interactive terminal: a spinner in piped or machine output is
  // noise, and JSON output must stay pure.
  const spin =
    !json && process.stdout.isTTY
      ? spinner("Assembling receipts…").start()
      : null;

  const runs: BuiltRun[] = [];
  let totalEvents = 0;
  let totalReceipts = 0;
  // Named outside the loop so a failure can say which run it died on.
  let current = "";

  try {
    for (const [index, path] of paths.entries()) {
      current = path;
      // One run's events at a time: the assembler's progressive path costs
      // O(events × operations), which stays bounded per run but would not be if
      // a whole events directory were folded as one.
      const events = createFileReader(path).read();
      // The run counter only means something when there is more than one to count.
      const prefix =
        paths.length > 1 ? `run ${index + 1}/${paths.length} · ` : "";

      // The progressive assembler exists to feed a progress indicator, and it
      // pays for that by finalizing every operation on every event. With no
      // spinner to feed — piped, or `--json` — take the eager path, which is
      // documented to produce exactly the progressive run's final snapshot.
      let last: RunProgress;
      if (spin === null) {
        const { receipts, unassigned } = assembleReceipts(events, template);
        last = {
          processed: events.length,
          total: events.length,
          receipts,
          unassigned,
        };
      } else {
        last = { processed: 0, total: 0, receipts: [], unassigned: [] };
        for (const progress of assembleReceiptsProgressively(
          events,
          template,
        )) {
          last = progress;
          spin.update({
            text: `Assembling receipts… ${prefix}${progress.processed}/${progress.total} events`,
          });
        }
      }

      // Aligned with `paths` by construction; the guard is for
      // `noUncheckedIndexedAccess`.
      const run = ids[index] ?? runIdFromPath(path);
      // Persist every receipt regardless of output format — writing is the store
      // layer's job, independent of what the terminal shows.
      for (const receipt of last.receipts)
        writeReceipt(receipt, run, receiptsDir);

      totalEvents += last.total;
      totalReceipts += last.receipts.length;
      runs.push({
        run,
        path,
        receipts: last.receipts,
        unassigned: last.unassigned,
      });
    }
  } catch (cause) {
    // A running spinner holds the event loop open, so leaving it up would turn
    // any read failure into a CLI that prints an error and then hangs.
    spin?.error({ text: `Failed on ${current}` });
    // Each run is written as it is assembled, so an earlier run's receipts are
    // already on disk. Say so: a store that was half updated must not look
    // untouched to whoever reads the error.
    const written =
      runs.length > 0
        ? ` — receipts for ${runs.length} earlier ${
            runs.length === 1 ? "run" : "runs"
          } were already written to ${receiptsDir}`
        : "";
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)} (while building ${current})${written}`,
      { cause },
    );
  }

  const noun = totalReceipts === 1 ? "receipt" : "receipts";
  const across = runs.length > 1 ? ` across ${runs.length} runs` : "";
  spin?.success({
    text: `Assembled ${totalReceipts} ${noun} from ${totalEvents} events${across}`,
  });

  const result: BuildResult = { runs, template: source };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  // Which file the template came from, always — a verdict read without knowing
  // which shape produced it isn't reproducible by whoever reads it next.
  console.log(color.dim(`\n  template: ${source.path}`));

  for (const built of runs) {
    // And which run produced it, for the same reason: two runs of one program
    // yield receipts with identical operation ids and different contents.
    console.log(color.dim(`  run: ${built.path}\n`));

    built.receipts.forEach((receipt, index) => {
      if (index > 0) console.log(color.dim("  ────────────────────────────"));
      console.log(renderReceipt(receipt));
      console.log("");
    });
    if (built.receipts.length === 0) {
      console.log(color.yellow("  no operations found in this run\n"));
    }
    if (built.unassigned.length > 0) {
      const evNoun = built.unassigned.length === 1 ? "event" : "events";
      console.log(
        color.dim(
          `  ${built.unassigned.length} run-level ${evNoun} not attributed to any operation\n`,
        ),
      );
    }
  }

  return result;
}

export const buildCommand: TraceCommand = {
  register(program: Command): void {
    const build = program
      .command("build")
      .argument(
        "[file...]",
        "ndjson run files to build from (default: the latest in the events directory)",
      )
      .option(
        "--all",
        "build every run in the events directory, not just the latest",
      )
      .option(
        "--template <name|path>",
        "operation template to apply to every operation",
        DEFAULT_TEMPLATE,
      );

    // No commander default here: left undefined, "not given" stays
    // distinguishable from "given", which is what lets `--dir` supply the
    // templates directory and an explicit `--templates-dir` still outrank it.
    withTraceDir(build)
      .option(
        "--templates-dir <path>",
        "directory holding the project's own templates (overrides --dir)",
      )
      .option(
        "--json",
        "emit machine-readable JSON instead of a terminal summary",
      )
      .description("Assemble one receipt per operation from a run's events")
      .action(
        (
          files: string[],
          opts: {
            all?: boolean;
            template: string;
            dir: string;
            templatesDir?: string;
            json?: boolean;
          },
        ) => {
          runBuild(files, {
            all: opts.all,
            template: opts.template,
            dir: opts.dir,
            templatesDir: opts.templatesDir,
            json: opts.json,
          });
        },
      );
  },
};
