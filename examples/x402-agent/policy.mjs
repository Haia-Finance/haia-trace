/**
 * The agent's spend policy, in the form the product is meant to be consumed:
 * a machine reading receipts, with no human in the loop.
 *
 * The rule is one line — do not continue a spend chain on an operation that is
 * not complete — and everything else here is reporting. Exits non-zero when any
 * operation is unresolved, so the same file works as a CI gate.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RECEIPTS_DIR = ".trace/receipts";

function loadReceipts(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    console.error(`no receipts in ${dir} — run \`pnpm demo\` first`);
    process.exit(2);
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

const receipts = loadReceipts(RECEIPTS_DIR);
let blocked = 0;

for (const receipt of receipts) {
  const id = receipt.operation.operation_id ?? "operation";

  // The policy. One field decides it.
  if (receipt.completeness === "full") {
    console.log(`✔ ${id}  complete — safe to continue spending`);
    continue;
  }

  blocked++;
  console.log(`✖ ${id}  ${receipt.completeness} — stopping the spend chain`);

  // Why, in the receipt's own words: an unclosed milestone is never a silent
  // hole, it carries what its absence means.
  for (const gap of receipt.missing) {
    const why = gap.why ?? `expected one of: ${gap.expected_events.join(", ")}`;
    console.log(`    missing ${gap.stage} — ${why}`);
  }
  for (const fault of receipt.exceptions) {
    console.log(`    fault   ${fault.event_type}`);
  }
}

console.log(
  blocked === 0
    ? `\nall ${receipts.length} operations complete`
    : `\n${blocked} of ${receipts.length} operations unresolved — the agent stops here`,
);

process.exit(blocked === 0 ? 0 : 1);
