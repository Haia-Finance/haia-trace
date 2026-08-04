# @usehaia/trace-core

The contracts and deterministic receipt assembler at the heart of
[Haia Trace](https://github.com/Haia-Finance/haia-trace). Most users reach for
the [CLI](https://github.com/Haia-Finance/haia-trace/tree/main/packages/cli) or
the [x402 adapter](https://github.com/Haia-Finance/haia-trace/tree/main/packages/x402)
instead — depend on `trace-core` directly when you're **building your own capture
adapter** or **embedding the assembler**.

Zero runtime dependencies. ESM only, Node ≥ 22 (the assembler is also
runtime-agnostic; the file-backed store lives behind the `/file` subpath).

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
  differently. A witness may name the `role` that has to have observed it, for
  the case where two roles share a vocabulary.
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

## Persist events (the `/file` subpath)

The event sink is defined as a runtime-agnostic contract in the root export
(`EventWriter` / `EventReader`, plus the NDJSON codec `encodeEventLine` /
`decodeEventLines`). The concrete file-backed implementation — the only place
`node:fs` is imported — lives behind the `/file` subpath:

```ts
import {
  createFileEventReader,
  createRunEventWriter,
  listRunFiles,
  readLatestRun,
  runIdFromPath,
} from "@usehaia/trace-core/file";

const RUNS = ".trace/events";

// Producing: one run file per session, named for its start time.
const writer = createRunEventWriter(RUNS);   // .trace/events/<run>.ndjson
writer.write(event);

// Reading it back: the newest run in that directory.
const events = readLatestRun(RUNS)?.read() ?? [];

// Or every run, oldest first — assembled one at a time, never concatenated:
for (const path of listRunFiles(RUNS)) {
  assembleReceipts(createFileEventReader(path).read(), template);  // per run
  runIdFromPath(path);                                        // e.g. "1721709600000"
}
```

`listRunFiles` is a list rather than a reader over every run at once on purpose.
Events carry no run id, and `context_id` is only unique within a run — an adapter
is free to number operations per session — so concatenating two runs and grouping
by `context_id` would fold unrelated operations into a single receipt.

Every path is an argument — this package holds no directory of its own. Core
describes events and assembles receipts; where those live is the caller's
decision, and a default here would be a filesystem convention two packages had to
keep agreeing on. So the producer and whoever reads the runs back must be pointed
at the same directory. `haia-trace` reads and writes `.trace/events` unless its
`--dir` says otherwise, which is what the example above matches. A relative path
resolves against the working directory — what an app started from its own project
root wants; pass an absolute one when the cwd is not fixed.

`createRunEventWriter` is fail-open about the run file: if the directory or the
file cannot be created for a reason no later write can clear — a container whose
working directory the process may not write to is the usual cause — the error
goes to `onError` and the writer it returns accepts events and drops them. You
get one report of the real cause rather than one per captured event, and a
handler that throws is absorbed rather than surfacing in your code. A failure
that may pass, such as the open-file limit, is reported and then recorded through
once it clears. Passing no directory at all is a caller mistake rather than a
disk condition, and still throws.

Wire `onError` on any producer whose run file matters. Recording nothing is the
correct outcome when the disk refuses, but without a handler that refusal has
nowhere to go, and the run is simply absent.

## License

[MIT](https://github.com/Haia-Finance/haia-trace/blob/main/LICENSE)
