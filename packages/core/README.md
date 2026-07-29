# @usehaia/trace-core

The contracts and deterministic receipt assembler at the heart of
[Haia Trace](https://github.com/Haia-Finance/haia-trace). Most users reach for
the [CLI](https://github.com/Haia-Finance/haia-trace/tree/main/packages/cli) or
the [x402 adapter](https://github.com/Haia-Finance/haia-trace/tree/main/packages/x402)
instead — depend on `trace-core` directly when you're **building your own capture
adapter** or **embedding the assembler**.

Zero runtime dependencies. ESM only, Node ≥ 20 (the assembler is also
runtime-agnostic; the file-backed store lives behind the `/node` subpath).

## Install

```sh
npm install @usehaia/trace-core
```

## The three contracts

- **Event** — the normalized shape every capture adapter emits: a namespaced
  `event_type`, an `occurred_at`, an optional `context_id` grouping one
  operation's events, a `seq`, the observing `role`, and a redacted `payload`.
  Written append-only as NDJSON.
- **Template** — a declarative description of an operation as a sequence of
  milestone **stages**. Each stage's `match` is a match-set: any one of its
  events closes the stage, since different roles witness the same milestone
  differently.
- **Receipt** — the verdict the assembler produces from `(events, template)`:
  each stage's state with the evidence behind it, the required stages still
  `missing` (each with an explanation), the `exceptions` observed, and the full
  event set for provenance. `full` only when every required stage is confirmed,
  at least one stage closed, and no fault was observed; otherwise `partial`.

## Assemble a receipt

```ts
import { assembleReceipts, type TraceEvent } from "@usehaia/trace-core";

const events: TraceEvent[] = [ /* ... one run's events ... */ ];
const template = /* an OperationTemplate */;

const { receipts } = assembleReceipts(events, template);
```

An `OperationTemplate` is plain data; validate an untrusted one (e.g. parsed from
YAML) with `assertOperationTemplate` before assembling against it.

The assembler is a **pure, deterministic function**: no LLM, no randomness. The
same events and template always yield the same Receipt, byte for byte — the
evidence-chain guarantee. Events are split into operations by `context_id`, and
one Receipt is produced per operation.

`assembleReceiptsProgressively(events, template)` yields the same result as an
iterator of progress snapshots, for streaming a live count over a large run.

## Mint events (building an adapter)

`createRecorder` is the one place an adapter mints events — it owns the session's
`seq` counter and stamps `event_id`, `occurred_at`, and `adapter`, so you supply
only the meaningful fields:

```ts
import { createRecorder } from "@usehaia/trace-core";

const recorder = createRecorder({ adapter: "trace-x402" });

const event = recorder.event({
  event_type: "x402.payment.required",
  role: "client",
  context_id: requestId,          // from your runtime's async context
  payload: { resource: "/api/data" }, // redacted — never keys or signatures
});
```

## Persist events (the `/node` subpath)

The event sink is defined as a runtime-agnostic contract in the root export
(`EventWriter` / `EventReader`, plus the NDJSON codec `encodeEventLine` /
`decodeEventLines`). The concrete file-backed implementation — the only place
`node:fs` is imported — lives behind the `/node` subpath:

```ts
import {
  createFileReader,
  createRunWriter,
  DEFAULT_RUN_DIR,
  listRunFiles,
  readLatestRun,
  runIdFromPath,
} from "@usehaia/trace-core/node";

// Producing: one run file per session, named for its start time.
const writer = createRunWriter();   // .trace/events/<run>.ndjson
writer.write(event);

// Reading it back: the newest run in that directory.
const events = readLatestRun(DEFAULT_RUN_DIR)?.read() ?? [];

// Or every run, oldest first — assembled one at a time, never concatenated:
for (const path of listRunFiles(DEFAULT_RUN_DIR)) {
  assembleReceipts(createFileReader(path).read(), template);  // per run
  runIdFromPath(path);                                        // e.g. "1721709600000"
}
```

`listRunFiles` is a list rather than a reader over every run at once on purpose.
Events carry no run id, and `context_id` is only unique within a run — an adapter
is free to number operations per session — so concatenating two runs and grouping
by `context_id` would fold unrelated operations into a single receipt.

`createRunWriter()` and the CLI's `build` share one default directory, so a
producer that configures nothing and the assembler meet without a path being
agreed. That path is relative to the working directory, which is what an app
started from its own project root wants; pass `dir` when the cwd is not fixed.

## License

[MIT](https://github.com/Haia-Finance/haia-trace/blob/main/LICENSE)
