/**
 * The agent's spend policy, in the form the product is meant to be consumed:
 * a machine reading receipts, with no human in the loop.
 *
 * The rule is one line — do not continue a spend chain on an operation that is
 * not complete — and everything else here is reporting. Exits non-zero when any
 * operation is unresolved, so the same file works as a CI gate.
 *
 * It judges the *latest* run, which is the one `pnpm demo` just built. Receipts
 * are named `<run>~<operation>.json` and accumulate, so every earlier run stays
 * on disk as evidence — but a payment that failed an hour ago is not a reason to
 * block the spending an agent is doing now, and a gate that can only be cleared
 * by deleting old receipts would teach exactly the wrong habit.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RECEIPTS_DIR = ".trace/receipts";

/** The run a receipt file belongs to — the name up to the separator. */
function runOf(name) {
  const cut = name.indexOf("~");
  return cut === -1 ? "" : name.slice(0, cut);
}

function loadLatestRun(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    console.error(`no receipts in ${dir} — run \`pnpm demo\` first`);
    process.exit(2);
  }
  const files = names.filter((name) => name.endsWith(".json")).sort();
  // Run ids are start timestamps, so the greatest is the most recent.
  const latest = files.map(runOf).reduce((a, b) => (a > b ? a : b), "");
  const runs = new Set(files.map(runOf));
  return {
    run: latest,
    older: runs.size - 1,
    receipts: files
      .filter((name) => runOf(name) === latest)
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8"))),
  };
}

const { run, older, receipts } = loadLatestRun(RECEIPTS_DIR);
let blocked = 0;

console.log(
  `run ${run}${older > 0 ? ` · ${older} earlier ${older === 1 ? "run" : "runs"} kept on disk` : ""}\n`,
);

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
