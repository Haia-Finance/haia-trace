/**
 * `haia-trace receipt list | show` — reading the receipts `build` has written.
 *
 * `build` assembles receipts and writes them under the Trace root; these two read
 * them back. `list` answers "what is in the store?" with one line per receipt —
 * the run, the operation, the verdict — and `show` answers "what happened in this
 * operation?" by rendering the stored verdict in full. Between them they replace
 * the `ls` plus `jq` that reading the store used to take, and they mean a consumer
 * never has to know how a receipt file is named.
 *
 * The namespace is deliberately read-only. Unlike a template, a receipt is never
 * authored: it is *derived* from a run's events, so `build` remains the only thing
 * that creates one and stays a top-level command. There is no `receipt new`, and
 * nothing here writes.
 *
 * The file name is the only record of which run a receipt came from — the Receipt
 * contract has no run field — so both commands go through `../store.js` rather
 * than reading the directory themselves. That is also what lets them address a
 * receipt whose `context_id` is a URL: the store escapes such an id into the file
 * name, and only the store can turn it back.
 *
 * Both `run*` functions stay free of commander so they test directly, and neither
 * decides where receipts live — that contract belongs to `../paths.js`.
 */

import type { Receipt } from "@usehaia/trace-core";
import type { Command } from "commander";

import { traceDirs } from "../paths.js";
import { renderReceiptList, renderReceipts } from "../render/receipt.js";
import {
  findReceipt,
  latestRun,
  listReceipts,
  type ReceiptLookup,
  type StoredReceipt,
  type StoredReceipts,
  type UnreadableReceipt,
} from "../store.js";
import { color, symbol } from "../ui.js";
import { checkStatus, STATUSES, type Status, withTraceDir } from "./options.js";
import type { TraceCommand } from "./types.js";

export interface ReceiptListOptions {
  /** Root Trace directory. Defaults to `.trace`. */
  dir?: string;
  /**
   * Directory receipts are read from. Defaults to `<dir>/receipts`. A seam for
   * callers and tests, not a flag — `build` treats its own the same way, so the
   * two halves of the store are configured by exactly one user-facing option.
   */
  receiptsDir?: string;
  /** Show only receipts from this run. Defaults to every run in the store. */
  run?: string;
  /** Show only receipts with this verdict. */
  status?: Status;
  /** Emit machine-readable JSON instead of a terminal listing. */
  json?: boolean;
}

/**
 * One line of the store's index. Deliberately a *summary*: `list` says what is in
 * the store, so it carries the fields a reader scans or filters on and not the
 * receipt itself. `show` is where the whole verdict — stages, gaps, and the events
 * behind them — is printed.
 */
export interface ReceiptIndexEntry {
  /** The run the receipt was assembled from. */
  run: string;
  /** The operation, and the id `receipt show` takes to fetch it. */
  operation: string;
  /** The file it was read from. */
  path: string;
  completeness: Receipt["completeness"];
  /** The template the verdict was assembled against. */
  template: string;
  title?: string;
}

export interface ReceiptListResult {
  receipts: ReceiptIndexEntry[];
  /** Files named like a receipt that could not be read. */
  unreadable: UnreadableReceipt[];
}

export interface ReceiptShowOptions {
  /** Root Trace directory. Defaults to `.trace`. */
  dir?: string;
  /** Directory receipts are read from. Defaults to `<dir>/receipts`. */
  receiptsDir?: string;
  /** The run to show from. Defaults to the most recent run in the store. */
  run?: string;
  /** Emit the stored receipts as JSON instead of a terminal rendering. */
  json?: boolean;
}

/** The receipts shown, and which run they came from — the run being implicit by default. */
export interface ReceiptShowResult {
  run: string;
  receipts: Receipt[];
  /**
   * Files named like a receipt that could not be read, the same list `list` emits.
   *
   * Carried in the JSON and not only warned about on stderr, because the consumer
   * that most needs to know is the one not reading the terminal: a spend policy
   * reading `{ run, receipts }` would otherwise see a clean, complete-looking answer
   * with no way to tell that part of the store was passed over.
   */
  unreadable: UnreadableReceipt[];
}

/** Turn a stored receipt into its index line. */
function toIndexEntry(stored: StoredReceipt): ReceiptIndexEntry {
  const { operation, completeness } = stored.receipt;
  return {
    run: stored.run,
    operation: stored.operation,
    path: stored.path,
    completeness,
    template: operation.template,
    ...(operation.title === undefined ? {} : { title: operation.title }),
  };
}

/**
 * What to say when nothing readable is left to show. Names the directory, because
 * "no receipts" is nearly always a root that was never built into or a recorder
 * pointed somewhere else — neither diagnosable without the path.
 *
 * A store whose every file failed to parse is *not* an empty one, and must not be
 * described as one: "run build first" would send someone to rebuild a store that
 * already holds their receipts, when the fix is to look at why they won't read.
 */
function emptyStore(dir: string, stored: StoredReceipts): string {
  if (stored.unreadable.length > 0) {
    const noun = stored.unreadable.length === 1 ? "file" : "files";
    return `no readable receipts in ${dir} — ${stored.unreadable.length} ${noun} could not be read`;
  }
  return `no receipts in ${dir} — run \`haia-trace build\` first`;
}

/**
 * Every run the store knows of, oldest first — including runs whose only receipts
 * are unreadable, since those runs are in the store whether or not they can be read.
 */
function runsOf(stored: StoredReceipts): string[] {
  return [
    ...new Set(
      [...stored.receipts, ...stored.unreadable].map((entry) => entry.run),
    ),
  ].sort();
}

/**
 * The error for a run that yielded no readable receipts.
 *
 * Three different situations reach this, and they must not sound alike: the run is
 * not in the store, the run *is* in the store but every one of its receipts is
 * corrupt, or the store holds nothing at all. Naming a damaged run among the "runs
 * in the store" while claiming it has no receipts would contradict itself, and would
 * point at a typo when the fix is to look at the files.
 */
function noReadableRun(
  dir: string,
  run: string,
  stored: StoredReceipts,
): Error {
  const damaged = stored.unreadable.filter((entry) => entry.run === run);
  if (damaged.length > 0) {
    const noun = damaged.length === 1 ? "receipt" : "receipts";
    return new Error(
      `no readable receipts for run "${run}" in ${dir} — its ${damaged.length} ${noun} could not be read`,
    );
  }

  const runs = runsOf(stored);
  return new Error(
    runs.length === 0
      ? emptyStore(dir, stored)
      : `no receipts for run "${run}" in ${dir} — runs in the store: ${runs.join(", ")}`,
  );
}

/**
 * Report every unreadable file, whatever the query was.
 *
 * Not filtered alongside the receipts: a file that cannot be parsed is a fact
 * about the store, not a result of the question asked. A listing that hid one
 * because it fell outside a `--run` would let a store that is partly unreadable
 * present as intact.
 *
 * Written to **stderr**. It is a diagnostic about the store rather than part of the
 * answer, and putting it on stdout would splice a warning line into `--json` ahead
 * of the document, leaving output that no longer parses. That also means it survives
 * a redirect: `receipt list --json > out.json` still shows the damage on the terminal.
 */
function warnUnreadable(unreadable: UnreadableReceipt[]): void {
  if (unreadable.length === 0) return;
  const noun = unreadable.length === 1 ? "file" : "files";
  console.error(
    `\n${symbol.warning} ${color.yellow(`${unreadable.length} ${noun} in the store could not be read:`)}`,
  );
  for (const file of unreadable) {
    console.error(color.dim(`    ${file.reason}`));
  }
}

/** Print the store's index — every stored receipt, or the subset a filter selects. */
export function runReceiptList(
  options: ReceiptListOptions = {},
): ReceiptListResult {
  const dir = options.receiptsDir ?? traceDirs(options.dir).receipts;
  checkStatus(options.status);

  const stored = listReceipts(dir);
  // Reported on every path out of here, including the ones that throw: a store
  // that is partly unreadable must never present as intact, and refusing a query
  // is no reason to withhold the reason it might have failed.
  warnUnreadable(stored.unreadable);

  let selected = stored.receipts;

  if (options.run !== undefined) {
    selected = selected.filter((entry) => entry.run === options.run);
    // A `--run` that matches nothing is a named thing that isn't there, unlike a
    // `--status` that matches nothing — which is a real answer about the store.
    // So this refuses, and says which runs it could have shown instead.
    if (selected.length === 0) throw noReadableRun(dir, options.run, stored);
  }

  // The count the filter was applied to — after `--run`, not before. Reporting the
  // whole store's total against a one-run query would describe a search nobody ran.
  const searched = selected.length;

  if (options.status !== undefined) {
    selected = selected.filter(
      (entry) => entry.receipt.completeness === options.status,
    );
  }

  const result: ReceiptListResult = {
    receipts: selected.map(toIndexEntry),
    unreadable: stored.unreadable,
  };

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  if (selected.length === 0) {
    // Either nothing readable is in the store, or a filter excluded all of it. The
    // two look identical on screen otherwise, and call for different next steps.
    const where = options.run === undefined ? dir : `run ${options.run}`;
    console.log(
      searched === 0
        ? color.dim(emptyStore(dir, stored))
        : color.dim(
            `no ${options.status} receipts among the ${searched} in ${where}.`,
          ),
    );
    return result;
  }

  console.log(renderReceiptList(selected));
  return result;
}

/**
 * Render one stored receipt, or every receipt of one run.
 *
 * With no operation named it shows the whole of the most recent run — "how did the
 * run I just built go?", which is the question asked most often and the one that
 * needs no ids to hand.
 */
export function runReceiptShow(
  operation?: string,
  options: ReceiptShowOptions = {},
): ReceiptShowResult {
  const dir = options.receiptsDir ?? traceDirs(options.dir).receipts;

  const stored = listReceipts(dir);
  warnUnreadable(stored.unreadable);

  // `latestRun` counts the runs of unreadable files too. A run whose receipts are
  // all corrupt is still the newest run in the store, and passing over it here
  // would answer "how did the run I just built go?" with an *older* run's verdict —
  // silently, and clean, which is the worst way to be wrong about a payment.
  const run = options.run ?? latestRun(stored);
  if (run === null) {
    // `show` with nothing to show is a failure, unlike `list` — the caller asked
    // for a verdict and there is none, so this must not exit 0.
    throw new Error(emptyStore(dir, stored));
  }

  const inRun = stored.receipts.filter((entry) => entry.run === run);
  // Nothing readable under this run — which `noReadableRun` tells apart from a run
  // that isn't there at all, since a corrupt newest run is exactly what `latestRun`
  // now selects and the two call for different fixes.
  if (inRun.length === 0) throw noReadableRun(dir, run, stored);

  const shown =
    operation === undefined
      ? inRun
      : [
          resolve(
            dir,
            run,
            operation,
            inRun,
            findReceipt(stored, run, operation),
          ),
        ];

  return report(
    {
      run,
      receipts: shown.map((entry) => entry.receipt),
      unreadable: stored.unreadable,
    },
    options,
  );
}

/**
 * The one receipt a lookup named, or the error explaining why there isn't one.
 *
 * The two failures are kept apart because they call for opposite fixes: an id
 * that matched nothing is a typo or the wrong run, while a prefix that matched
 * several needs *more* characters, not different ones. Telling a caller who typed
 * a valid short prefix that no such receipt exists would send them looking for
 * the wrong problem.
 */
function resolve(
  dir: string,
  run: string,
  operation: string,
  inRun: StoredReceipt[],
  lookup: ReceiptLookup,
): StoredReceipt {
  if (lookup.entry !== null) return lookup.entry;
  if (lookup.ambiguous.length > 0) {
    throw new Error(
      `"${operation}" matches ${lookup.ambiguous.length} operations in run "${run}" (${dir}) — use more of the id: ${lookup.ambiguous
        .map((entry) => entry.operation)
        .join(", ")}`,
    );
  }
  throw notFound(dir, run, operation, inRun);
}

/**
 * The error for an operation the run does not hold. Names the run as well as the
 * operation — an id is unique only within its run — and then says what the run
 * *does* hold, which is nearly always enough to spot the typo.
 *
 * Throws rather than returning, so the caller can use it where a value is expected.
 */
function notFound(
  dir: string,
  run: string,
  operation: string,
  inRun: StoredReceipt[],
): never {
  throw new Error(
    `no receipt for "${operation}" in run "${run}" (${dir}) — operations in that run: ${inRun
      .map((entry) => entry.operation)
      .join(", ")}`,
  );
}

/** Print the result in the requested form and return it. */
function report(
  result: ReceiptShowResult,
  options: ReceiptShowOptions,
): ReceiptShowResult {
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  // Which run, always: it is implicit unless `--run` was given, and two runs of
  // one program yield receipts with identical operation ids and different verdicts.
  console.log(color.dim(`  run: ${result.run}\n`));
  console.log(renderReceipts(result.receipts));
  return result;
}

export const receiptCommand: TraceCommand = {
  register(program: Command): void {
    const receipt = program
      .command("receipt")
      .description("Read the receipts build has assembled");

    withTraceDir(
      receipt
        .command("list")
        .description("List the receipts in the store, grouped by run"),
    )
      .option("--run <id>", "show only receipts from this run")
      .option(`--status <${STATUSES.join("|")}>`, "show only this verdict")
      .option("--json", "emit machine-readable JSON instead of a listing")
      .action(
        (opts: {
          dir: string;
          run?: string;
          status?: Status;
          json?: boolean;
        }) => {
          runReceiptList({
            dir: opts.dir,
            run: opts.run,
            status: opts.status,
            json: opts.json,
          });
        },
      );

    withTraceDir(
      receipt
        .command("show")
        .argument(
          "[operation]",
          "operation to show (default: every operation in the run)",
        )
        .description("Render a stored receipt in full"),
    )
      .option("--run <id>", "run to show from (default: the most recent)")
      .option("--json", "emit the stored receipts as JSON")
      .action(
        (
          operation: string | undefined,
          opts: { dir: string; run?: string; json?: boolean },
        ) => {
          runReceiptShow(operation, {
            dir: opts.dir,
            run: opts.run,
            json: opts.json,
          });
        },
      );
  },
};
