/**
 * The local receipt store — the CLI's write side of `.trace/`.
 *
 * A receipt is a *derived* artifact: the run's events are the source of truth, and
 * a receipt is assembled on request and written here. Writing is deterministic
 * (BR-4) — the same receipt yields a byte-identical file — because the assembler
 * fixes the receipt's field order and we pretty-print it verbatim.
 *
 * This is the store layer, kept out of core: core assembles receipts but never
 * decides where they live. `build` writes here now; `last` / `rerun` will reuse it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Receipt } from "@usehaia/trace-core";

/** Default receipts directory, relative to the working directory. */
export const RECEIPTS_DIR = join(".trace", "receipts");

/**
 * A filesystem-safe base name for an operation id. `context_id` is opaque — it can
 * be a URL-ish or otherwise arbitrary string — so any character outside a safe set
 * is replaced, keeping the file name valid on every OS (notably no `/` or `:`).
 */
function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Write one receipt to `<dir>/<operation_id>.json` and return the path written.
 * Pretty-printed with a trailing newline. Creates `dir` if absent.
 */
export function writeReceipt(receipt: Receipt, dir: string = RECEIPTS_DIR): string {
  const id = receipt.operation.operation_id ?? "operation";
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safeName(id)}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}
