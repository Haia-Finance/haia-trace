# Webhook fixtures

Complete Circle webhook v2 notification bodies, one JSON file per delivery —
the inputs replay-driven tests feed to the pipeline.

**Provenance — synthetic, derived from documented shapes, not captured from
live traffic.** The envelope follows the v2 notification schema
([webhooks reference](https://developers.circle.com/api-reference/webhooks));
the `transactions.*` payloads follow the transaction object of the Wallets API
(a v2 `notification` is the resource in the shape of its API's response); the
`contracts.eventLog` payload follows the example in
[circlefin/skills — monitor-events](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-smart-contract-platform/references/monitor-events.md),
with the event of the [arc-escrow](https://github.com/circlefin/arc-escrow)
`RefundProtocol` contract. All ids, addresses, hashes, and topic values are
fabricated; `topics`/`data` are plausible hex, not a real ABI encoding.

Confirm against real captures (Circle Console → Webhook Logs) before relying
on exact field sets, and replace these files with captured bodies as they
become available — the file names and shapes are the contract, not the values.

That warning earned itself. A live run showed a `contracts.eventLog` delivery
names its event in **`eventSignature`**, and carries `firstConfirmDate` rather
than the `updateDate` a transaction notification has. The synthetic payload had
been written with an `eventName` field that live traffic does not send, so every
contract event normalized to nothing — and the fixture agreed with the bug,
because both came from the same reading of the docs. The synthetic files below
have been reshaped to the captured field set.

## The escrow arc

Three files tell one coherent story around a single escrow contract
(`0x92b7…0987`), so replaying that set yields ONE operation: a failed deposit
attempt, a successful lock, and funds arriving back out of the contract. They
are named explicitly by the replay suite rather than globbed, so captures from
other contracts can live here without splitting the arc into several operations.

| File | What it represents |
|---|---|
| `transactions-inbound-complete.json` | USDC arriving at a wallet FROM the escrow contract (source = contract); terminal `COMPLETE` (on Arc, `CONFIRMED` may be skipped entirely) |
| `transactions-outbound-failed.json` | A failed deposit attempt TOWARD the contract (destination = contract), with `errorReason` |
| `contracts-eventlog-payment-created.json` | An event monitor firing for `PaymentCreated` — funds locked in the escrow contract |

## Live captures

Real deliveries from an Arc testnet run, kept verbatim — `live-` prefixed so
the arc above stays one operation. They pin the FIELD SHAPES the mapper reads,
which is what a hand-written fixture cannot be trusted to do: these two are why
the `eventSignature` defect surfaced at all.

Both belong to one escrow contract (`0xba69…f48e`) and to throwaway test
wallets, so the addresses and hashes are safe to ship.

| File | What it represents |
|---|---|
| `live-contracts-eventlog-payment-created.json` | `PaymentCreated` — 3 USDC locked in the escrow contract |
| `live-contracts-eventlog-refund.json` | `Refund` — the same funds returned to the depositor |

A capture of a *failed* transaction is still missing: nothing failed during the
run, and forcing a failure was not worth a broken stand. `transactions-outbound-failed.json`
therefore stays synthetic.
