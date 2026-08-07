# Webhook fixtures

Complete Circle webhook v2 notification bodies, one JSON file per delivery. They
are test inputs only — not shipped in the published package (`files` lists
`dist` alone).

## The files

`live-` prefixed files are real deliveries from an Arc testnet run, kept
verbatim. They pin the field shapes the mapper reads, which a hand-written body
cannot be trusted to do: a synthetic fixture written from the docs once named a
contract event in `eventName`, a field live traffic does not send, so every
contract event normalized to nothing and the fixture agreed with the bug. The
remaining files are synthetic, reshaped to the captured field set.

| File | What it is |
| --- | --- |
| `live-contracts-eventlog-payment-created.json` | `PaymentCreated` — 3 USDC locked in the escrow contract |
| `live-contracts-eventlog-refund.json` | `Refund` — the same funds returned to the depositor |
| `contracts-eventlog-payment-created.json` | `PaymentCreated` for the synthetic escrow arc |
| `transactions-inbound-complete.json` | USDC arriving at a wallet from the escrow contract; terminal `COMPLETE` |
| `transactions-outbound-failed.json` | A failed deposit attempt toward the contract, with `errorReason` |

The two live captures share one escrow contract (`0xba69…f48e`) and belong to
throwaway test wallets, so their addresses and hashes are safe to publish. The
three synthetic files share a different contract (`0x92b7…0987`) and tell one
story — a failed deposit, a lock, funds coming back out — so replaying that set
yields exactly one operation. Nothing failed during the live run, so a captured
*failed* transaction is still missing.

## How tests use them

- `src/fixtures.test.ts` — every `.json` here must parse as a valid v2 envelope,
  and all `notification_id`s must be unique so replaying the whole directory does
  not self-dedupe.
- `src/normalize.test.ts` — the mapping assertions: event types, `context_id`,
  `occurred_at`, the payload allowlist.
- `packages/cli/src/replay.test.ts` — signs the three synthetic files with a test
  key and pushes them through the real handler, the NDJSON codec, and the
  `escrow-arc` template. It names those three explicitly rather than globbing, so
  captures from other contracts can live here without splitting the arc into
  several operations.

## Adding one

Drop in a complete body (envelope included) with a unique `notificationId`.
Prefer a real capture — Circle Console → Webhook Logs — and prefix it `live-`;
anything belonging to a contract other than the synthetic arc must stay out of
`ARC_FIXTURES` in the replay test. Check that addresses, wallet ids, and hashes
belong to throwaway test resources before committing: this repository is public.
