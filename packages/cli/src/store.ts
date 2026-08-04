/**
 * The local receipt store — the CLI's read and write side of `.trace/`.
 *
 * A receipt is a *derived* artifact: the run's events are the source of truth, and
 * a receipt is assembled on request and written here. Writing is deterministic
 * (BR-4) — the same receipt yields a byte-identical file — because the assembler
 * fixes the receipt's field order and we pretty-print it verbatim.
 *
 * A receipt is identified by the run it came from *and* its operation, so both
 * name the file, joined by a character neither half can contain. `context_id`
 * alone is not enough: an adapter is free to number operations per session — the
 * x402 one mints a uuid, but nothing in the contract says every adapter must —
 * so two runs of the same program can produce the same operation ids for
 * entirely different payments, and a store keyed by operation alone would
 * silently overwrite one with the other.
 *
 * The directory stays flat rather than nesting a folder per run: readers glob it
 * for `*.json` — the example agent's spend policy does — and a reader that finds
 * nothing must not be able to read as "nothing to block on".
 *
 * Reading is the other half of the same mapping, and the reason it lives beside
 * the write: the file name is the *only* place a receipt's run id is recorded —
 * the Receipt contract has no run field — so a reader has to decode the name to
 * say which run a verdict came from. `receipt list` and `receipt show` read
 * through here, so neither can name a file this module wouldn't write.
 *
 * This is the store layer, kept out of core: core assembles receipts but never
 * decides where they live. Nor does this module — the directory is an argument,
 * resolved from the Trace root by `./paths.js`.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  Receipt,
  ReceiptException,
  ReceiptMissing,
  ReceiptStage,
} from "@usehaia/trace-core";

import { isErrno } from "./fs.js";

/** Receipts are stored as JSON; also how a directory listing tells them apart. */
const RECEIPT_EXT = ".json";

/**
 * Joins the run and the operation in a receipt's file name. Outside the set
 * `safeName` keeps, so it is a character no encoded segment can contain — which
 * is what makes the two halves of a name unambiguous.
 */
const SEPARATOR = "~";

/**
 * A filesystem-safe name segment. Both a run id and a `context_id` are opaque —
 * either can be a URL-ish or otherwise arbitrary string — so any character
 * outside a safe set is escaped, keeping the file name valid on every OS
 * (notably no `/` or `:`).
 *
 * The escape is percent-encoding at a fixed width rather than "replace the
 * unsafe character with `_`", because the mapping has to be *injective*: a
 * many-to-one replacement makes `a/b` and `a b` — or the run/operation pair
 * `a_`/`_x` and `a`/`x` — land on one file, and one receipt would silently
 * overwrite the other, which is the very failure the run-scoped name exists to
 * prevent. `%` is itself escaped, so no two inputs share an output.
 */
function safeName(id: string): string {
  return id.replace(
    /[^A-Za-z0-9._-]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
  );
}

/**
 * The inverse of `safeName` — the id a stored name segment was made from.
 *
 * Being injective is what makes `safeName` reversible at all, and being
 * *fixed-width* is what makes the reverse unambiguous: an escape is always `%`
 * plus exactly four hex digits, and a literal `%` in the id was escaped too, so
 * no encoded output can be read two ways. A non-BMP character was escaped as its
 * two UTF-16 code units, and decoding each in turn restores the pair.
 *
 * Anything that isn't an escape we would have written is left as it stands: this
 * decodes our own names, and is not a general percent-decoder.
 */
function decodeName(name: string): string {
  return name.replace(/%([0-9A-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * The file a run/operation pair maps to. The one place that mapping is written
 * down, so a listing can never name a file the reader wouldn't read and the write
 * side can never disagree with the read side about where a receipt lives.
 */
export function receiptPath(
  dir: string,
  run: string,
  operation: string,
): string {
  return join(
    dir,
    `${safeName(run)}${SEPARATOR}${safeName(operation)}${RECEIPT_EXT}`,
  );
}

/** The operation key a receipt is stored under when it named no operation. */
const UNNAMED_OPERATION = "operation";

/** The operation half of a receipt's file name — its `operation_id`, or the fallback. */
function operationKey(receipt: Receipt): string {
  return receipt.operation.operation_id ?? UNNAMED_OPERATION;
}

/**
 * Write one receipt to `<dir>/<run>~<operation_id>.json` and return the path
 * written. Pretty-printed with a trailing newline. Creates `dir` if absent.
 */
export function writeReceipt(
  receipt: Receipt,
  run: string,
  dir: string,
): string {
  mkdirSync(dir, { recursive: true });
  const path = receiptPath(dir, run, operationKey(receipt));
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}

/** One receipt on disk: the verdict, plus the run and operation its name records. */
export interface StoredReceipt {
  /**
   * The run the receipt was assembled from, decoded from its file name — the only
   * place a receipt's run is recorded, since the Receipt contract has no run field.
   */
  run: string;
  /**
   * The operation half of the name: the receipt's `operation_id`, or `operation`
   * for one that named none. It is the key `findReceipt` looks up, so it is what a
   * listing must show for the two commands to address the same receipt.
   */
  operation: string;
  /** The file it was read from. */
  path: string;
  receipt: Receipt;
}

/** A file in the receipts directory that is one of ours but could not be read. */
export interface UnreadableReceipt {
  /**
   * The run its name records. Carried even though the file could not be parsed:
   * the name alone says which run is damaged, and a reader that only learns
   * "something is broken" cannot tell whether it is the run it just built.
   */
  run: string;
  /** The operation its name records. */
  operation: string;
  path: string;
  /** Why it could not be read — unparseable JSON, or a shape that isn't a receipt. */
  reason: string;
}

/** What a receipts directory holds: the receipts read, and the files that failed. */
export interface StoredReceipts {
  /** Sorted by run then operation — oldest run first, run ids being timestamps. */
  receipts: StoredReceipt[];
  /**
   * Files named like a receipt that could not be read. Surfaced rather than
   * skipped: a store that is partly unreadable must not present as complete, the
   * same rule the receipt itself follows for a missing stage.
   */
  unreadable: UnreadableReceipt[];
}

/**
 * Compare two ids the way core orders run files — by code unit, the default
 * `Array.prototype.sort` gives `listRunFiles`.
 *
 * Deliberately not `localeCompare`: collation ignores case and punctuation
 * differences that a plain sort respects, so the two would disagree on which run
 * is the most recent. `build` picks the run to build with core's ordering, and
 * `receipt show` picks the run to display with this one — for the pair to name the
 * same run, the comparison has to be the same comparison.
 */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Order two receipts of one run the way `build` prints them: by when each
 * operation started.
 *
 * Not by operation id. An id is an adapter's own string with no ordering in it —
 * x402 mints uuids — so sorting on it would list a run's payments in an order
 * with no meaning, and `build`, which reports operations in first-appearance
 * order, would disagree with `receipt list` about which payment came first.
 *
 * A receipt's `events` are already in the assembler's total order
 * (`occurred_at`, then `seq`, then `event_id`), so the first of them is the
 * operation's first appearance and comparing on the same triple reproduces that
 * ordering exactly. The id breaks a tie, keeping the sort total for two
 * operations whose first events somehow compare equal.
 *
 * The array is read defensively: `isReceiptShape` does not validate `events`,
 * because no renderer needs it, and this module reads files it did not
 * necessarily write. A receipt without a readable first event sorts by id alone
 * rather than taking the listing down with it.
 */
function compareOperations(a: StoredReceipt, b: StoredReceipt): number {
  const first = a.receipt.events?.[0];
  const other = b.receipt.events?.[0];
  if (first !== undefined && other !== undefined) {
    const order =
      compareIds(first.occurred_at, other.occurred_at) ||
      (first.seq === other.seq ? 0 : first.seq < other.seq ? -1 : 1) ||
      compareIds(first.event_id, other.event_id);
    if (order !== 0) return order;
  }
  return compareIds(a.operation, b.operation);
}

/**
 * The run/operation pair a receipt file name records, or `null` if the name isn't
 * one this module writes.
 *
 * Exactly one separator is the test: `safeName` escapes `~`, so neither encoded
 * half can contain one, and a name with none or several was not written here.
 * Such a file is somebody else's and is passed over in silence — unlike a file
 * that *is* ours and won't parse, which is reported.
 */
function parseReceiptName(
  file: string,
): { run: string; operation: string } | null {
  if (!file.endsWith(RECEIPT_EXT)) return null;
  const stem = file.slice(0, -RECEIPT_EXT.length);
  const halves = stem.split(SEPARATOR);
  if (halves.length !== 2) return null;
  const [run, operation] = halves as [string, string];
  // A missing half — `~op.json`, `run~.json` — leaves nothing to address the
  // receipt by, so the name is not one of ours either.
  if (run === "" || operation === "") return null;
  return { run: decodeName(run), operation: decodeName(operation) };
}

/** Whether every element of `value` is an array that satisfies `each`. */
function isArrayOf(
  value: unknown,
  each: (element: object) => boolean,
): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (element) =>
        typeof element === "object" && element !== null && each(element),
    )
  );
}

/**
 * Whether a parsed value has the shape the renderers and the JSON output rely on.
 *
 * Core carries no receipt validator, by design: a receipt is produced by the
 * assembler, not parsed from untrusted input. Reading the store back breaks that
 * premise — a file here can be truncated mid-write, hand-edited, or left by an
 * older CLI — so this checks that a bad file fails with a sentence instead of a
 * stack trace from inside a renderer.
 *
 * That guarantee is what fixes the depth: checking only the containers would let
 * `stages: [{}]` through to `renderReceipt`, which reads `stage.id.length` and dies
 * on an anonymous `TypeError` naming no file — exactly the failure this exists to
 * prevent. So every field a renderer or the receipt list *reads* is checked, and
 * nothing beyond: this is a guard for our own output, not a validator of the
 * contract, which remains core's business.
 */
function isReceiptShape(value: unknown): value is Receipt {
  if (typeof value !== "object" || value === null) return false;
  const { operation, completeness, stages, missing, exceptions } =
    value as Partial<Receipt>;
  return (
    typeof operation === "object" &&
    operation !== null &&
    typeof operation.template === "string" &&
    (completeness === "full" || completeness === "partial") &&
    // `id` and `required` are read by the stage lines, `state` decides the glyph.
    isArrayOf(
      stages,
      (stage) =>
        typeof (stage as ReceiptStage).id === "string" &&
        typeof (stage as ReceiptStage).required === "boolean" &&
        typeof (stage as ReceiptStage).state === "string",
    ) &&
    // A gap with no `why` falls back to joining `expected_events`.
    isArrayOf(
      missing,
      (gap) =>
        typeof (gap as ReceiptMissing).stage === "string" &&
        Array.isArray((gap as ReceiptMissing).expected_events),
    ) &&
    isArrayOf(
      exceptions,
      (fault) => typeof (fault as ReceiptException).event_type === "string",
    )
  );
}

/**
 * Read and parse a receipt if the file exists, else `null`.
 *
 * Only a genuinely absent file is `null` — a present-but-broken one throws, so a
 * receipt that exists but cannot be read never reads as one that was never built.
 * Every failure names the path, because the file to open is the useful half of the
 * message. Absence is decided by the read itself rather than a prior `existsSync`,
 * so nothing can slip in between the check and the read.
 */
function readReceiptIfPresent(path: string): Receipt | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw new Error(
      `could not read receipt (${path}): ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid receipt (${path}): ${(err as Error).message}`);
  }
  if (!isReceiptShape(parsed)) {
    throw new Error(
      `invalid receipt (${path}): not a receipt — expected an operation, a completeness, and well-formed stages, missing and exceptions`,
    );
  }
  return parsed;
}

/**
 * Every receipt in `dir`, sorted by run, then by when each operation started.
 *
 * An absent directory — or a path that is not one — reads as an empty store
 * rather than an error: a project that has not built yet has no receipts, which
 * is the normal case and the opposite of the built-in templates directory, whose
 * absence is a broken install.
 *
 * Each file is opened rather than read off its name alone. The name carries only
 * the run and the operation; the verdict a listing exists to show lives inside.
 */
export function listReceipts(dir: string): StoredReceipts {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (isErrno(err, "ENOENT") || isErrno(err, "ENOTDIR"))
      return { receipts: [], unreadable: [] };
    throw err;
  }

  const receipts: StoredReceipt[] = [];
  const unreadable: UnreadableReceipt[] = [];

  for (const file of entries) {
    const name = parseReceiptName(file);
    if (name === null) continue;
    const path = join(dir, file);
    try {
      const receipt = readReceiptIfPresent(path);
      // Absent between the listing and the read — deleted underneath us. Nothing
      // to report: it is no longer in the store the listing describes.
      if (receipt !== null) receipts.push({ ...name, path, receipt });
    } catch (err) {
      // One unreadable file must not cost the rest of the listing — the answer to
      // "what is in the store?" is still worth having, with the gap named.
      unreadable.push({ ...name, path, reason: (err as Error).message });
    }
  }

  return {
    receipts: receipts.sort(
      (a, b) => compareIds(a.run, b.run) || compareOperations(a, b),
    ),
    unreadable: unreadable.sort(
      (a, b) =>
        compareIds(a.run, b.run) || compareIds(a.operation, b.operation),
    ),
  };
}

/**
 * The most recent run the store knows of, or `null` when it holds nothing at all.
 *
 * Counts the runs of *unreadable* files as well as readable ones. A run whose
 * receipts are all corrupt is still the newest run in the store, and skipping it
 * here would silently name an older one — handing back a passing verdict from a
 * previous run as though it were the current one.
 */
export function latestRun(stored: StoredReceipts): string | null {
  let latest: string | null = null;
  for (const entry of [...stored.receipts, ...stored.unreadable]) {
    if (latest === null || compareIds(entry.run, latest) > 0)
      latest = entry.run;
  }
  return latest;
}

/** What looking one receipt up by run and operation turned into. */
export interface ReceiptLookup {
  /** The receipt the id named, or `null` when no operation — or several — matched. */
  entry: StoredReceipt | null;
  /**
   * The receipts a prefix matched when it matched more than one. Empty in every
   * other case, so it is also what tells "several" apart from "none".
   */
  ambiguous: StoredReceipt[];
}

/**
 * One stored receipt by the pair that names it, matching an operation exactly or
 * by an unambiguous prefix of it.
 *
 * The prefix is what keeps the command usable: an operation id is an adapter's
 * own string, and x402's is a 36-character uuid that nobody types from memory.
 * The exact match is tried first, so a prefix can never shadow an id that is
 * genuinely in the store — and an ambiguous one resolves to nothing rather than
 * to whichever receipt happened to sort first, since showing the wrong payment's
 * verdict is worse than asking for more characters.
 *
 * Deliberately a search over `listReceipts` rather than a direct read of
 * `receiptPath(dir, run, operation)`. Going straight to the file would be cheaper,
 * but it can only ever see that one file — and a caller told "here is your receipt"
 * while the rest of the store is corrupt has been shown a store that looks intact.
 * Reading the directory is what lets every lookup report the damage it passed over.
 *
 * The lookup itself is why the store has a read side at all: `safeName` escapes
 * anything outside a bare-slug set, so the file holding a receipt for a URL-ish
 * `context_id` cannot be named by hand.
 */
export function findReceipt(
  stored: StoredReceipts,
  run: string,
  operation: string,
): ReceiptLookup {
  const inRun = stored.receipts.filter((entry) => entry.run === run);
  const exact = inRun.find((entry) => entry.operation === operation);
  if (exact !== undefined) return { entry: exact, ambiguous: [] };

  // An empty argument prefixes every id, which would make "show me nothing"
  // ambiguous rather than absent — and it is never an operation id, since
  // `parseReceiptName` refuses a name with an empty half.
  if (operation === "") return { entry: null, ambiguous: [] };

  const prefixed = inRun.filter((entry) =>
    entry.operation.startsWith(operation),
  );
  if (prefixed.length === 1) return { entry: prefixed[0]!, ambiguous: [] };
  return { entry: null, ambiguous: prefixed };
}
