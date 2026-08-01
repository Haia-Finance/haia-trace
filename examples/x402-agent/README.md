# Traced x402 agent

A buyer agent that pays two APIs over x402. Only the agent is instrumented — the
sellers are other people's services, and the agent has no access to their code,
their logs or their hooks. That is the normal case: you own your side of a
payment and nothing else.

```sh
pnpm demo     # run the agent, then assemble the receipts
pnpm policy   # the agent reads the verdict and decides whether to keep spending
```

## What you get

The first call settles. The second is signed, sent, and never comes back with a
settlement. `pnpm demo` records the run to `.trace/events/<run>.ndjson` and
assembles one receipt per operation, against the `x402-buyer` template — the
payment as the buyer's own client witnessed it:

```text
🧾 x402-buyer · op-1 · FULL      🧾 x402-buyer · op-2 · PARTIAL

  ✔ challenge   confirmed          ✔ challenge   confirmed
  ✔ payment     confirmed          ✔ payment     confirmed
  ✔ settlement  confirmed          ✖ settlement  not confirmed  required

  operation completed              exceptions
                                     ⚠ x402.payment.failed

                                   missing
                                     settlement — the payment was submitted, but
                                     no settlement response was observed

                                   operation not complete
```

The second operation is the point. A signed authorization left the agent, and
nothing came back that says what happened to it. The agent cannot tell a payment
that never settled from one that settled silently — and instead of guessing
either way, the receipt records the fault it saw and names the milestone that
stayed open.

`pnpm policy` then reads those receipts the way an agent would, and exits
non-zero:

```text
✔ op-1  complete — safe to continue spending
✖ op-2  partial — stopping the spend chain
    missing settlement — the payment was submitted, but no settlement response was observed
    fault   x402.payment.failed
```

Each `pnpm demo` is its own run, and receipts are keyed by run
(`.trace/receipts/<run>~<operation>.json`), so a second demo adds two more
receipts rather than replacing the first two — the agent numbers its operations
per session, so both runs really do contain an `op-1`. The policy judges the
latest run, the one the demo just built, and says how many earlier runs are still
on disk: old evidence is kept, but a payment that failed an hour ago is not what
decides whether the agent may spend now.

## The integration

One line, plus the sink it writes to:

```js
const writer = createRunEventWriter(".trace/events");

trace(agent, { writer });
```

The run directory is the producer's to choose; `.trace/events` is the one
`haia-trace build` reads from unless its `--dir` says otherwise, so naming it here
is what makes recording and assembling meet.

### Mirroring to the Control Plane

Give the demo an ingest key and the same events also go to a Haia Control Plane
project, where the dashboard can show them:

```sh
HAIA_INGEST_URL=https://<host> HAIA_INGEST_KEY=<key> pnpm demo
```

Nothing about the recording changes — two sinks compose into one writer:

```js
const writer = createMulticastEventWriter(runWriter, cpWriter);
```

The local run file stays the source of truth the receipts are assembled from;
the Control Plane is a mirror. Uploading is batched, so `buyer.mjs` awaits
`writer.flush?.()` before it exits — the file sink writes inside `write` and has
no `flush` to call, which is why the call is optional.

The environment variables belong to this script, not to the library: the sink
takes its configuration through its constructor and never reads ambient state.
With no key set, the demo runs entirely offline.

`trace()` returns an attestation (`kind`, `attached`, `missing`, `complete`), so
a run that recorded nothing is distinguishable from a recorder that never
connected. The demo prints it on startup.

Capture is passive: the handlers only record and always return `undefined`, so
they can never steer a payment the way an x402 hook is allowed to. The worst case
of a bug here is a missing event, never a broken payment.

## The buyer's template

`x402-buyer` — the template `haia-trace build` applies by default — covers the
payment as the client sees it: the 402 challenge, the signed payment, the
settlement response. It ends where the client's own evidence ends.

A seller who wants their own side recorded attaches the same way, and assembles
it against `x402-seller`. Nothing here depends on that, and this example
deliberately does without it.

## What is real and what is not

Real: the `@x402/core` client, its hook registries, the recorder attached to it,
the Event Contract written to disk, and the assembler that turns it into
receipts.

Simulated: the money and the sellers. There is no chain, no facilitator and no
wallet, so the lifecycle is driven locally by invoking the hooks the SDK would
invoke, with the context objects it would pass. This example fakes the payment,
never the trace.

The signed authorization carries a `signature` field on purpose: grep the run
file for it and it is not there. Redaction is allowlist-based — payloads carry
normalized fields, never credentials.
