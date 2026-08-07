# @usehaia/trace-core

The contracts and the deterministic receipt assembler behind
[Haia Trace](https://github.com/Haia-Finance/haia-trace). Three contracts —
**Event** (what an adapter observes), **Template** (the expected shape of an
operation) and **Receipt** (the verdict the two produce) — plus the assembler
that folds one into the other.

Most people reach for the CLI or a capture adapter instead. Depend on this
package directly when you are **writing your own capture adapter** or
**embedding the assembler**.

Zero runtime dependencies, ESM only, Node ≥ 22. The root export touches no
`node:*` API and runs in any runtime; the file-backed sink lives behind the
`/file` subpath and the Control Plane sink behind `/cp`.

📖 **[developers.haia.finance/sdk/core](https://developers.haia.finance/sdk/core)**
— contracts, API, sinks, determinism rules.

## Install

```sh
npm install @usehaia/trace-core
```

## Assemble a receipt

```ts
import {
  assembleReceipts,
  assertOperationTemplate,
  type OperationTemplate,
} from "@usehaia/trace-core";

// `parsed` is whatever your YAML/JSON parser produced — validated here.
const template: OperationTemplate = assertOperationTemplate(parsed, "x402-buyer.yaml");

// One receipt per operation, grouped by `context_id`.
const { receipts, unassigned } = assembleReceipts(events, template);
```

The assembler is pure — no clock, no random id, no I/O, no model. The same
events and template always produce a byte-identical receipt.

## Record events

```ts
import { createRecorder } from "@usehaia/trace-core";
import { createRunEventWriter } from "@usehaia/trace-core/file";

const recorder = createRecorder({
  adapter: "my-adapter",
  writer: createRunEventWriter(".trace/events"),
});

recorder.record({
  event_type: "my.payment.submitted",
  context_id: requestId,              // groups one operation's events
  payload: { resource: "/api/data" }, // redacted — never keys or signatures
});
```

Sinks never throw — a producer sits in a payment path, so a sink failure has to
degrade to "capture stopped", never "payment broke". `write` returns whether the
event was accepted, which is what lets a webhook receiver answer 500 and have its
source redeliver.

## License

[MIT](https://github.com/Haia-Finance/haia-trace/blob/main/LICENSE)
