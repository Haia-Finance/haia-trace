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

Both calls settle. One returns the data that was paid for; the other returns
nothing usable. `pnpm demo` records the run to `.trace/events/<run>.ndjson` and
assembles one receipt per operation:

```text
🧾 x402-payment · op-1 · FULL          🧾 x402-payment · op-2 · PARTIAL

  ✔ intent           confirmed          ✔ intent           confirmed
  ✔ payment          confirmed          ✔ payment          confirmed
  ✔ settlement       confirmed          ✔ settlement       confirmed
  ✔ paid_action      confirmed          ✖ paid_action      not confirmed  required

  operation completed                   missing
                                          paid_action — the paid action's result
                                          was not observed

                                        operation not complete
```

The second operation is the point. The payment is beyond dispute — the seller
returned a settled response with a transaction hash — and the agent still has
nothing. A block explorer, the agent's own wallet and the seller's confirmation
would each report success. Only the receipt reports the gap.

`pnpm policy` then reads those receipts the way an agent would, and exits
non-zero:

```text
✔ op-1  complete — safe to continue spending
✖ op-2  partial — stopping the spend chain
    missing paid_action — the paid action's result was not observed
```

## The integration

One line, plus the sink it writes to:

```js
const writer = createRunWriter();

trace(agent, { writer });
```

The writer defaults to the same run directory `haia-trace build` reads from, so
recording and assembling meet without a path being configured on either side.

`trace()` returns an attestation (`kind`, `attached`, `missing`, `complete`), so
a run that recorded nothing is distinguishable from a recorder that never
connected. The demo prints it on startup.

Capture is passive: the handlers only record and always return `undefined`, so
they can never steer a payment the way an x402 hook is allowed to. The worst case
of a bug here is a missing event, never a broken payment.

## Closing the last milestone, without the seller

x402 ends at settlement — the protocol has no "you got what you paid for" step,
and the seller is not going to report one. So the `paid_action` milestone is
closed by the only party who can observe it: the buyer, when the response it
paid for actually arrives.

```js
writer.write(
  app.event({
    event_type: "http.response.delivered",
    context_id: operation,
    role: "client",
    payload: { status: 200, url, bytes: 8123 },
  }),
);
```

That is the whole mechanism for adding a source: emit an event whose type the
template already matches. No adapter, no core change, and no cooperation from the
counterparty — which is why the first operation reads `FULL` and the second,
where this line never runs, does not.

A seller who wants their own side recorded attaches the same way — `trace()` on
an `x402ResourceServer` picks up verify and settle. It is not required for any of
the above, and this example deliberately does without it.

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
