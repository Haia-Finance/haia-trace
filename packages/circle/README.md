# @usehaia/trace-circle

The [Haia Trace](https://github.com/Haia-Finance/haia-trace) capture adapter for
[Circle webhook v2 notifications](https://developers.circle.com/api-reference/webhooks)
— Wallets transactions and Contracts event logs. Verified deliveries become
normalized, redacted Trace events.

The source is external: Circle POSTs signed notifications to an HTTPS endpoint,
at-least-once and unordered. This package hosts no server. It gives you the
pieces — signature verification, envelope validation, deduplication,
normalization — and one handler that composes them, so it embeds into whatever
route already receives the POSTs.

ESM only, Node ≥ 22, no runtime dependencies beyond `@usehaia/trace-core`. The
runtime code uses only platform globals (Web Crypto, `TextEncoder`, `atob`), so
it also runs on edge runtimes.

📖 **[developers.haia.finance/sdk/circle](https://developers.haia.finance/sdk/circle)**
— every event it records, the HTTP decision table, options.

## Install

```sh
npm install @usehaia/trace-circle
```

## Receive a delivery

`createWebhookHandler` runs the whole pipeline and returns the HTTP status your
route should answer with:

```ts
import { mkdirSync } from "node:fs";
import { createVerifier, createWebhookHandler } from "@usehaia/trace-circle";
import { createFileEventWriter } from "@usehaia/trace-core/file";

mkdirSync(".trace/events", { recursive: true });

const handler = createWebhookHandler({
  verifier: createVerifier({ resolveKey }), // fetches Circle's public key
  // A refused event is reported by returning false, and the handler answers
  // 500 so Circle retries. Core's file sink already does this.
  write: createFileEventWriter(".trace/events/webhooks.ndjson").write,
});

// Any framework: `headers` may be a fetch `Headers` or a Node header record.
export async function POST(request: Request): Promise<Response> {
  // The body exactly as received — the signature covers these bytes.
  const rawBody = await request.text();
  const result = await handler.handle(rawBody, request.headers);
  return new Response(null, { status: result.status });
}
```

> **`write` must never report success for an event it did not keep.** Answering
> 200 for an unpersisted delivery stops Circle's retries, which were the only way
> that event could still be saved.

Verification runs before parsing: nothing about an unauthenticated body is
trusted, not even that it is JSON.

## Then build a receipt

Point the sink at the directory
[`@usehaia/trace-cli`](https://www.npmjs.com/package/@usehaia/trace-cli) reads,
and build against the shipped escrow template:

```sh
haia-trace build --template escrow-arc
```

Circle's notifications witness the money, not the obligation. `escrow-arc`
requires an `agreement` stage no external source can close, so a webhook-only run
assembles as `partial` until your own service records its `escrow.*` events into
the same run directory.

## License

[MIT](https://github.com/Haia-Finance/haia-trace/blob/main/LICENSE)
