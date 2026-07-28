# @usehaia/trace-circle

The [Haia Trace](https://github.com/Haia-Finance/haia-trace) capture adapter for
[Circle webhook v2 notifications](https://developers.circle.com/api-reference/webhooks)
— Wallets transactions and Contracts event logs.

Unlike an in-process adapter, this source is **external**: Circle POSTs signed
notifications to an HTTPS endpoint, at-least-once and unordered. The package
provides the pieces that physics requires — it hosts no HTTP server of its own,
so the pieces embed into whatever server receives the POSTs.

Zero runtime dependencies beyond `@usehaia/trace-core`.

> **Status: early.** The pipeline (verify → parse → dedupe → record) is
> implemented; the default event vocabulary for the mapping lands next — until
> then, `normalize` is supplied by the caller.

## Install

```sh
npm install @usehaia/trace-circle
```

## Handle a delivery

`createWebhookHandler` composes the pieces and returns the HTTP decision; the
surrounding server only relays it:

```ts
import { createWebhookHandler, createVerifier } from "@usehaia/trace-circle";
import { createFileWriter } from "@usehaia/trace-core/node";

const handler = createWebhookHandler({
  verifier: createVerifier({ resolveKey }), // see below
  // The event mapping is injected; the pipeline does not fix the vocabulary.
  normalize: (envelope) => [
    {
      event_type: `circle.${envelope.notification_type}`,
      payload: { notification_id: envelope.notification_id },
    },
  ],
  // MUST throw on failure so the handler answers 500 and Circle retries.
  // Core's file sink is fail-open by design; a throwing error handler turns it
  // into the fail-loud write a webhook needs:
  write: createFileWriter(".trace/events/webhooks.ndjson", (err) => {
    throw err;
  }).write,
});

// In your route (any framework — the handler is structural about headers):
const result = await handler.handle(rawBody, request.headers);
return respond(result.status);
```

The decision contract: **400** — not a valid Circle notification (bad
signature, malformed envelope), retrying cannot fix it; **500** — our side
failed (key resolution, persistence), Circle should retry; **200** — accepted,
including retries of already-accepted deliveries. One handler serves any number
of route paths: Circle requires a unique URL per subscription, but a delivery's
source is identified by `notification_type`, not by the URL it arrived on.

The pieces below are what the handler composes — usable directly if you need a
different pipeline.

## Verify a notification

Every v2 notification is signed (ECDSA P-256 / SHA-256) over the **raw** request
body. Verification must run on the bytes exactly as received — re-serializing
parsed JSON can change them and break a valid signature.

```ts
import { createVerifier } from "@usehaia/trace-circle";

// The public-key endpoint needs your Circle API credentials, so the fetch is
// injected rather than built in. The verifier caches each key id.
const verifier = createVerifier({
  resolveKey: async (keyId) => {
    const res = await fetch(
      `https://api.circle.com/v2/notifications/publicKey/${keyId}`,
      { headers: { Authorization: `Bearer ${process.env.CIRCLE_API_KEY}` } },
    );
    if (res.status === 404) return null; // unknown key id → verifies false
    const { data } = await res.json();
    return data.publicKey; // base64 SPKI, exactly as returned
  },
});

// In your route handler — rawBody is the body as received, not re-parsed:
const ok = await verifier.verify(
  rawBody,
  request.headers["x-circle-signature"],
  request.headers["x-circle-key-id"],
);
if (!ok) return respond(400); // not from Circle; a retry cannot fix it
```

## Validate the envelope and deduplicate

```ts
import {
  createMemoryDedupeStore,
  parseNotificationEnvelope,
} from "@usehaia/trace-circle";

const dedupe = createMemoryDedupeStore();

const envelope = parseNotificationEnvelope(rawBody); // throws loudly on malformed input

if (!dedupe.firstSeen(envelope.notification_id)) {
  return respond(200); // a retry of an accepted delivery — acknowledge, skip
}
// … normalize and record, then respond(200).
// If persisting fails, respond(500) so Circle retries — never swallow and 200.
```

Circle delivers **at-least-once** (retries reuse the same `notificationId`) and
**unordered** — so deduplicate before writing, and key any processing off the
state inside the payload, never off arrival order. The in-memory store is
bounded and process-local; a long-lived listener should back the one-method
`DedupeStore` interface with durable storage.
