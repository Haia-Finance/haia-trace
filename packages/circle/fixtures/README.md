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

| File | What it represents |
|---|---|
| `transactions-inbound-complete.json` | USDC arrived at a wallet; terminal `COMPLETE` (on Arc, `CONFIRMED` may be skipped entirely) |
| `transactions-outbound-failed.json` | An outbound transfer that failed, with `errorReason` |
| `contracts-eventlog-payment-created.json` | An event monitor firing for `PaymentCreated` — funds locked in the escrow contract |
