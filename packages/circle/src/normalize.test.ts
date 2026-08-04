import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseNotificationEnvelope } from "./envelope.js";
import { normalizeNotification } from "./normalize.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

function fixture(name: string) {
  return parseNotificationEnvelope(
    readFileSync(join(FIXTURES_DIR, name), "utf8"),
    name,
  );
}

/** The escrow contract the synthetic arc fixtures revolve around. */
const CONTRACT = "0x92b7e5c1d4f3a2b1c0d9e8f7a6b5c4d3e2f10987";

describe("normalizeNotification — transactions", () => {
  it("maps an inbound COMPLETE to circle.transaction.inbound.complete", () => {
    const events = normalizeNotification(
      fixture("transactions-inbound-complete.json"),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("circle.transaction.inbound.complete");
  });

  it("groups a wallet transaction under its counterparty: the contract", () => {
    // Inbound: money arrived FROM the contract → source is the counterparty.
    const inbound = normalizeNotification(
      fixture("transactions-inbound-complete.json"),
    )[0];
    expect(inbound?.context_id).toBe(CONTRACT);

    // Outbound: money was sent TOWARD the contract → destination is.
    const outbound = normalizeNotification(
      fixture("transactions-outbound-failed.json"),
    )[0];
    expect(outbound?.context_id).toBe(CONTRACT);
  });

  it("takes occurred_at from the payload's updateDate, not the envelope", () => {
    const event = normalizeNotification(
      fixture("transactions-inbound-complete.json"),
    )[0];
    // Fixture: updateDate 12:00:00.412, envelope timestamp 12:00:00.845.
    expect(event?.occurred_at).toBe("2026-07-28T12:00:00.412Z");
  });

  it("maps a FAILED outbound to .failed and keeps error_reason", () => {
    const event = normalizeNotification(
      fixture("transactions-outbound-failed.json"),
    )[0];
    expect(event?.event_type).toBe("circle.transaction.outbound.failed");
    expect(event?.payload.error_reason).toBe(
      "INSUFFICIENT_NATIVE_TOKEN_BALANCE",
    );
  });

  it("treats CONFIRMED and COMPLETE as the same fact — Arc can skip CONFIRMED", () => {
    const envelope = fixture("transactions-inbound-complete.json");
    const confirmed = {
      ...envelope,
      notification: { ...envelope.notification, state: "CONFIRMED" },
    };
    expect(normalizeNotification(confirmed)[0]?.event_type).toBe(
      "circle.transaction.inbound.complete",
    );
  });

  it("skips non-terminal states as delivery noise", () => {
    const envelope = fixture("transactions-inbound-complete.json");
    for (const state of ["INITIATED", "QUEUED", "SENT", "STUCK"]) {
      const intermediate = {
        ...envelope,
        notification: { ...envelope.notification, state },
      };
      expect(normalizeNotification(intermediate)).toEqual([]);
    }
  });

  it("lowercases the context so mixed-case addresses group together", () => {
    const envelope = fixture("transactions-inbound-complete.json");
    const upper = {
      ...envelope,
      notification: {
        ...envelope.notification,
        sourceAddress: CONTRACT.toUpperCase().replace("0X", "0x"),
      },
    };
    expect(normalizeNotification(upper)[0]?.context_id).toBe(CONTRACT);
  });
});

describe("normalizeNotification — contract events", () => {
  it("maps PaymentCreated to circle.contract.payment_created under the contract", () => {
    const events = normalizeNotification(
      fixture("contracts-eventlog-payment-created.json"),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("circle.contract.payment_created");
    expect(events[0]?.context_id).toBe(CONTRACT);
    expect(events[0]?.payload.event_signature).toBe(
      "PaymentCreated(uint256,address,uint256,uint256,address)",
    );
  });

  it("maps Withdrawal and Refund by the name before the signature's parenthesis", () => {
    const envelope = fixture("contracts-eventlog-payment-created.json");
    const cases: [string, string][] = [
      ["Withdrawal(address,uint256)", "circle.contract.withdrawal"],
      ["Refund(uint256,address,uint256)", "circle.contract.refund"],
    ];
    for (const [signature, expected] of cases) {
      const variant = {
        ...envelope,
        notification: { ...envelope.notification, eventSignature: signature },
      };
      expect(normalizeNotification(variant)[0]?.event_type).toBe(expected);
    }
  });

  it("skips contract events outside the mapped set", () => {
    const envelope = fixture("contracts-eventlog-payment-created.json");
    const unknown = {
      ...envelope,
      notification: {
        ...envelope.notification,
        eventSignature: "RefundToUpdated(uint256,address,address)",
      },
    };
    expect(normalizeNotification(unknown)).toEqual([]);
  });

  // A contract event names its signature in `eventSignature`; a notification
  // shaped with `eventName` is not something Circle sends, and mapping it would
  // let a fixture invent a field the API does not have.
  it("does not map a contract event that only carries eventName", () => {
    const envelope = fixture("contracts-eventlog-payment-created.json");
    const { eventSignature, ...rest } = envelope.notification;
    const renamed = {
      ...envelope,
      notification: { ...rest, eventName: eventSignature },
    };
    expect(normalizeNotification(renamed)).toEqual([]);
  });

  it("takes occurred_at from a contract event's firstConfirmDate, not the envelope", () => {
    const events = normalizeNotification(
      fixture("live-contracts-eventlog-refund.json"),
    );
    // The envelope was sent at 13:34:08.63; the chain confirmed at 13:34:07.
    expect(events[0]?.occurred_at).toBe("2026-08-04T13:34:07.000Z");
  });

  // The live captures are the guard against a fixture that agrees with a bug:
  // both were recorded from real deliveries, so a field the API does not send
  // cannot quietly become the shape the mapper is written against.
  it.each([
    [
      "live-contracts-eventlog-payment-created.json",
      "circle.contract.payment_created",
      55277356,
    ],
    ["live-contracts-eventlog-refund.json", "circle.contract.refund", 55277390],
  ])("maps the live capture %s", (file, expected, blockHeight) => {
    const events = normalizeNotification(fixture(file as string));
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe(expected);
    expect(events[0]?.context_id).toBe(
      "0xba69b54b0ec696a5a32d107bec5cceff7c1af48e",
    );
    expect(events[0]?.payload.block_height).toBe(blockHeight);
  });
});

describe("normalizeNotification — redaction and unknowns", () => {
  it("acknowledges unknown notification types with an empty mapping", () => {
    const envelope = fixture("transactions-inbound-complete.json");
    const unknown = { ...envelope, notification_type: "challenges.initialize" };
    expect(normalizeNotification(unknown)).toEqual([]);
  });

  it("copies ONLY allowlisted payload fields — nothing extra leaks through", () => {
    const envelope = fixture("transactions-inbound-complete.json");
    const poisoned = {
      ...envelope,
      notification: {
        ...envelope.notification,
        apiKey: "sk-secret",
        rawHeaders: { "x-circle-signature": "..." },
        entitySecret: "deadbeef",
      },
    };
    const payload = normalizeNotification(poisoned)[0]?.payload ?? {};
    const allowed = new Set([
      "notification_id",
      "notification_type",
      "transaction_id",
      "tx_hash",
      "blockchain",
      "state",
      "wallet_id",
      "source_address",
      "destination_address",
      "amounts",
      "token_id",
      "transaction_type",
      "error_reason",
      "contract_address",
    ]);
    for (const key of Object.keys(payload)) {
      expect(allowed.has(key), `unexpected payload key: ${key}`).toBe(true);
    }
    expect(JSON.stringify(payload)).not.toContain("secret");
    expect(JSON.stringify(payload)).not.toContain("deadbeef");
  });

  it("omits context_id when no counterparty can be derived — unassigned, not guessed", () => {
    const envelope = fixture("transactions-inbound-complete.json");
    const bare = {
      ...envelope,
      notification: {
        ...envelope.notification,
        sourceAddress: undefined,
        contractAddress: undefined,
      },
    };
    const event = normalizeNotification(bare as typeof envelope)[0];
    expect(event).toBeDefined();
    expect("context_id" in (event ?? {})).toBe(false);
  });

  it("falls back to the envelope timestamp when updateDate is unusable", () => {
    const envelope = fixture("transactions-inbound-complete.json");
    const noUpdate = {
      ...envelope,
      notification: { ...envelope.notification, updateDate: "not a date" },
    };
    expect(normalizeNotification(noUpdate)[0]?.occurred_at).toBe(
      "2026-07-28T12:00:00.845Z",
    );
  });
});
