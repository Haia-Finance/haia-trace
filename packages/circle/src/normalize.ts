/**
 * The default notification → event mapping: the adapter's vocabulary.
 *
 * Event types are namespaced by SOURCE (`circle.*`), the same convention the
 * rest of the Trace vocabulary follows (`x402.*`, `chain.*`): the adapter
 * records what Circle observed, and which operation milestone an event
 * witnesses is the template's decision, not the adapter's.
 *
 * The vocabulary:
 *
 * - `circle.transaction.inbound.complete` / `.failed` — a wallet transaction
 *   toward one of our wallets reached a terminal state. Direction comes from
 *   Circle's own taxonomy (the `transactions.inbound` / `transactions.outbound`
 *   notification types), and it is part of the name because a direction-less
 *   "transaction completed" could not witness a specific milestone: money
 *   ARRIVING from an escrow contract and money SENT toward one are different
 *   facts.
 * - `circle.transaction.outbound.complete` / `.failed` — same, for
 *   transactions our wallets sent.
 * - `circle.contract.payment_created` / `.withdrawal` / `.refund` — an event
 *   monitor observed the corresponding contract event (the events of the
 *   arc-escrow RefundProtocol contract). These carry the operation semantics
 *   a wallet transaction alone cannot: a deposit call and a release call are
 *   both outbound contract executions from a wallet's point of view.
 *
 * Deliberately NOT mapped (an empty result — the delivery is acknowledged but
 * nothing is recorded):
 *
 * - Non-terminal transaction states (`INITIATED` … `SENT`, `STUCK`,
 *   `ACCELERATED`) — delivery noise for a receipt; `CONFIRMED` and `COMPLETE`
 *   are both mapped to `.complete` because chains with instant finality (Arc)
 *   can skip `CONFIRMED` entirely.
 * - Contract events other than the three above, and unknown notification
 *   types — no template vocabulary exists for them yet.
 *
 * `context_id` — the operation an event belongs to — is the escrow contract's
 * address, lowercased: the demo deploys one contract per agreement, and the
 * address appears in both product payloads. For a wallet transaction the
 * contract is the COUNTERPARTY (the source of an inbound, the destination of
 * an outbound); a transaction unrelated to any escrow simply groups under its
 * own counterparty and yields a separate receipt.
 *
 * `occurred_at` is the fact's own time, never the delivery time: payload
 * `updateDate`, falling back to the envelope `timestamp` (send time), falling
 * back to the recorder's clock (arrival time) — each step strictly weaker.
 * Values are re-canonicalized to fixed-width ISO-8601 UTC because the
 * assembler orders events lexically and relies on that form.
 *
 * Payloads are ALLOWLISTED: only the fields named here are copied, so keys
 * Circle adds later — or anything resembling credentials — never leak into
 * the sink.
 */

import type { EventInput } from "@usehaia/trace-core";

import type { NotificationEnvelope } from "./envelope.js";

/** A non-empty string from an untrusted payload field, else `undefined`. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Re-encode a timestamp into canonical fixed-width ISO-8601 UTC (the form the
 * assembler's lexical ordering relies on), or `undefined` when unparseable.
 */
function canonicalTime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Terminal transaction states, per the Wallets state machine. */
const TERMINAL_OK = new Set(["CONFIRMED", "COMPLETE"]);
const TERMINAL_FAILED = new Set(["FAILED", "DENIED", "CANCELLED"]);

/** Contract event name (before the signature's `(`) → event type. */
const CONTRACT_EVENT_TYPES = new Map<string, string>([
  ["PaymentCreated", "circle.contract.payment_created"],
  ["Withdrawal", "circle.contract.withdrawal"],
  ["Refund", "circle.contract.refund"],
]);

/** Copy the allowlisted fields that are present, snake_cased, dropping the rest. */
function pick(
  source: Record<string, unknown>,
  fields: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(fields)) {
    const value = source[from];
    if (value !== undefined && value !== null) out[to] = value;
  }
  return out;
}

function normalizeTransaction(envelope: NotificationEnvelope): EventInput[] {
  const n = envelope.notification;
  const state = str(n.state);
  if (state === undefined) return [];

  const direction = envelope.notification_type.endsWith(".inbound")
    ? "inbound"
    : envelope.notification_type.endsWith(".outbound")
      ? "outbound"
      : undefined;
  if (direction === undefined) return [];

  let outcome: "complete" | "failed";
  if (TERMINAL_OK.has(state)) outcome = "complete";
  else if (TERMINAL_FAILED.has(state)) outcome = "failed";
  // Intermediate states are delivery noise for a receipt; the terminal state
  // arrives (or is retried) on its own.
  else return [];

  // The counterparty of our wallet — for an escrow flow, the contract.
  const counterparty =
    str(n.contractAddress) ??
    (direction === "inbound"
      ? str(n.sourceAddress)
      : str(n.destinationAddress));
  // Each fallback step is canonicalized on its own: an unparseable updateDate
  // must fall through to the envelope timestamp, not skip past it.
  const occurredAt =
    canonicalTime(str(n.updateDate)) ?? canonicalTime(envelope.timestamp);

  return [
    {
      event_type: `circle.transaction.${direction}.${outcome}`,
      ...(counterparty !== undefined
        ? { context_id: counterparty.toLowerCase() }
        : {}),
      ...(occurredAt !== undefined ? { occurred_at: occurredAt } : {}),
      payload: {
        notification_id: envelope.notification_id,
        notification_type: envelope.notification_type,
        ...pick(n, {
          id: "transaction_id",
          txHash: "tx_hash",
          blockchain: "blockchain",
          state: "state",
          walletId: "wallet_id",
          sourceAddress: "source_address",
          destinationAddress: "destination_address",
          amounts: "amounts",
          tokenId: "token_id",
          transactionType: "transaction_type",
          errorReason: "error_reason",
          contractAddress: "contract_address",
        }),
      },
    },
  ];
}

function normalizeContractEvent(envelope: NotificationEnvelope): EventInput[] {
  const n = envelope.notification;
  // `eventName` carries the full signature ("PaymentCreated(uint256,…)");
  // the name before the parenthesis selects the type.
  const name = str(n.eventName)?.split("(")[0];
  const event_type =
    name === undefined ? undefined : CONTRACT_EVENT_TYPES.get(name);
  if (event_type === undefined) return [];

  const contractAddress = str(n.contractAddress);
  // Each fallback step is canonicalized on its own: an unparseable updateDate
  // must fall through to the envelope timestamp, not skip past it.
  const occurredAt =
    canonicalTime(str(n.updateDate)) ?? canonicalTime(envelope.timestamp);

  return [
    {
      event_type,
      ...(contractAddress !== undefined
        ? { context_id: contractAddress.toLowerCase() }
        : {}),
      ...(occurredAt !== undefined ? { occurred_at: occurredAt } : {}),
      payload: {
        notification_id: envelope.notification_id,
        notification_type: envelope.notification_type,
        ...pick(n, {
          contractAddress: "contract_address",
          blockchain: "blockchain",
          txHash: "tx_hash",
          userOpHash: "user_op_hash",
          eventName: "event_name",
        }),
      },
    },
  ];
}

/**
 * The default mapping, in the shape `createWebhookHandler` expects for its
 * `normalize` option. Callers with a different vocabulary supply their own.
 */
export function normalizeNotification(
  envelope: NotificationEnvelope,
): EventInput[] {
  if (envelope.notification_type.startsWith("transactions.")) {
    return normalizeTransaction(envelope);
  }
  if (envelope.notification_type === "contracts.eventLog") {
    return normalizeContractEvent(envelope);
  }
  return [];
}
