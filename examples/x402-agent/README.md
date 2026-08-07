# Traced x402 agent

A buyer agent that pays two APIs over x402, records what it observed, and turns
that into receipts it can act on.

```sh
pnpm demo     # run the agent, then assemble the receipts
pnpm policy   # read the verdicts and decide whether to keep spending
pnpm clean    # drop the recorded events and receipts
```

The first call settles. The second is signed, sent, and never comes back with a
settlement.

## What is real and what is not

**Real:** the `@x402/core` client, its hook registries, the adapter attached to
it, the events written to disk, and the assembler that turns them into receipts.

**Simulated:** the money and the sellers. There is no chain, no facilitator and
no wallet, so `buyer.mjs` drives the lifecycle by invoking the hooks the SDK
would invoke, with the context objects it would pass. The payment is faked; the
trace is not.

Only the buyer is instrumented. The sellers are other people's services — no
access to their code, their logs or their hooks. That is the normal case: you own
your side of a payment and nothing else.

## The integration

One line, plus the sink it writes to (`buyer.mjs`):

```js
const writer = createRunEventWriter(".trace/events");

trace(agent, { writer });
```

The run directory is the producer's to choose; `.trace/events` is the one
`haia-trace build` reads from unless `--dir` says otherwise, so naming it here is
what makes recording and assembling meet.

`trace()` returns an attestation (`kind`, `attached`, `missing`, `complete`),
which the demo prints on startup — a run that recorded nothing is distinguishable
from a recorder that never connected.

## The receipts

`pnpm demo` records the run to `.trace/events/<run>.ndjson` and assembles one
receipt per operation against `x402-buyer`, the template covering the payment as
the client witnesses it. Shown side by side, with the operation ids cut short —
the real ones are full uuids:

```text
🧾 x402-buyer · ed2b9682… · FULL      🧾 x402-buyer · fe5bc1b6… · PARTIAL

  ✔ challenge   confirmed               ✔ challenge   confirmed
  ✔ payment     confirmed               ✔ payment     confirmed
  ✔ settlement  confirmed               ✖ settlement  not confirmed  required

  operation completed                   exceptions
                                          ⚠ x402.payment.failed

                                        missing
                                          settlement — the payment was submitted,
                                          but no settlement response was observed

                                        operation not complete
```

The second operation is the point. A signed authorization left the agent and
nothing came back saying what happened to it. The agent cannot tell a payment
that never settled from one that settled silently — so instead of guessing, the
receipt records the fault it saw and names the milestone that stayed open.

`pnpm policy` then reads those receipts the way an agent would, and exits
non-zero:

```text
run 1785858302473

✔ ed2b9682-c811-47b1-b8e7-4c8de4430e24  complete — safe to continue spending
✖ fe5bc1b6-04dc-4f0f-be42-70d94e7b2d37  partial — stopping the spend chain
    missing settlement — the payment was submitted, but no settlement response was observed
    fault   x402.payment.failed
```

Each `pnpm demo` is its own run, and receipts are keyed by run
(`.trace/receipts/<run>~<operation>.json`), so a second demo adds two more rather
than replacing the first two. The policy judges the latest run and, from the
second demo on, reports how many earlier runs are still on disk: old evidence is
kept, but a payment that failed an hour ago is not what decides whether the agent
may spend now.

## Redaction

The signed authorization in `buyer.mjs` carries a `signature` field on purpose.
Grep the run file for it:

```sh
grep -R SIGNATURE .trace/events/ || echo "the signature never reached the run file"
```

Payloads are built from an allowlist — normalized public facts, never
credentials.

## Mirroring to the Control Plane

Give the demo an ingest key and the same events also go to a Haia Control Plane
project:

```sh
HAIA_INGEST_URL=https://<host> HAIA_INGEST_KEY=<key> pnpm demo
```

Nothing about the recording changes — two sinks compose into one writer:

```js
const writer = createMulticastEventWriter(runWriter, cpWriter);
```

The local run file stays the source of truth the receipts are assembled from; the
Control Plane is a mirror. Uploading is batched, so `buyer.mjs` awaits
`writer.flush?.()` before it exits — the file sink writes inside `write` and has
no `flush`, which is why the call is optional.

The environment variables belong to this script, not to the library: the sink
takes its configuration through its constructor and never reads ambient state.
With no key set, the demo runs entirely offline.

## The other side

`x402-buyer` ends where the client's own evidence ends. A seller who wants their
own side recorded attaches `trace()` the same way and assembles against
`x402-seller`. Nothing here depends on that, and this example deliberately does
without it.
