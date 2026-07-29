/**
 * The local receipt store — the CLI's write side of `.trace/`.
 *
 * A receipt is a *derived* artifact: the run's events are the source of truth, and
 * a receipt is assembled on request and written here. Writing is deterministic
 * (BR-4) — the same receipt yields a byte-identical file — because the assembler
 * fixes the receipt's field order and we pretty-print it verbatim.
 *
 * A receipt is identified by the run it came from *and* its operation, so both
 * name the file, joined by a character neither half can contain. `context_id`
 * alone is not enough: an adapter is free to number
 * operations per session (the x402 one does — `op-1`, `op-2`, …), so two runs of
 * the same program produce the same operation ids for entirely different
 * payments, and a store keyed by operation alone would silently overwrite one
 * with the other.
 *
 * The directory stays flat rather than nesting a folder per run: readers glob it
 * for `*.json` — the example agent's spend policy does — and a reader that finds
 * nothing must not be able to read as "nothing to block on".
 *
 * This is the store layer, kept out of core: core assembles receipts but never
 * decides where they live. Nor does this module — the directory is an argument,
 * resolved from the Trace root by `./paths.js`. `build` writes here now;
 * `last` / `rerun` will reuse it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Receipt } from "@usehaia/trace-core";

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
 * Write one receipt to `<dir>/<run>~<operation_id>.json` and return the path
 * written. Pretty-printed with a trailing newline. Creates `dir` if absent.
 */
export function writeReceipt(
  receipt: Receipt,
  run: string,
  dir: string,
): string {
  const id = receipt.operation.operation_id ?? "operation";
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safeName(run)}${SEPARATOR}${safeName(id)}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}
