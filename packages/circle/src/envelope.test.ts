import { describe, expect, it } from "vitest";

import {
  assertNotificationEnvelope,
  parseNotificationEnvelope,
} from "./envelope.js";

/** A realistic v2 envelope in the documented shape (transactions.inbound). */
function validEnvelope(): Record<string, unknown> {
  return {
    subscriptionId: "8e29afe0-6d3d-4c47-a11d-8d1d24d8b1a3",
    notificationId: "5f4d63f1-2a80-4b45-a342-31b1b09a5cbf",
    notificationType: "transactions.inbound",
    notification: {
      id: "1af639ce-c8b2-54a6-af49-7aebc95aaac1",
      state: "COMPLETE",
      txHash: "0xf7cc8d6b26f1a6a0e0cc0f8f6a222166b9b1d2ab",
      blockchain: "ARC-TESTNET",
      walletId: "fe4a0d57-4a89-4b39-9e46-2f8fbf0a0f7a",
    },
    timestamp: "2026-07-28T12:00:00.000Z",
    version: 2,
  };
}

describe("assertNotificationEnvelope", () => {
  it("accepts a valid envelope and returns snake_case fields", () => {
    const envelope = assertNotificationEnvelope(validEnvelope());
    expect(envelope.notification_id).toBe(
      "5f4d63f1-2a80-4b45-a342-31b1b09a5cbf",
    );
    expect(envelope.notification_type).toBe("transactions.inbound");
    expect(envelope.notification.state).toBe("COMPLETE");
    expect(envelope.version).toBe(2);
  });

  it.each([
    ["subscriptionId"],
    ["notificationId"],
    ["notificationType"],
    ["notification"],
    ["timestamp"],
    ["version"],
  ])("rejects a missing %s, naming the field", (field) => {
    const value = validEnvelope();
    delete value[field];
    expect(() => assertNotificationEnvelope(value)).toThrow(field);
  });

  it("rejects an empty notificationId — it would disable deduplication", () => {
    const value = { ...validEnvelope(), notificationId: "" };
    expect(() => assertNotificationEnvelope(value)).toThrow("notificationId");
  });

  it("rejects a v1 envelope", () => {
    const value = { ...validEnvelope(), version: 1 };
    expect(() => assertNotificationEnvelope(value)).toThrow(
      "`version` must be 2",
    );
  });

  it("rejects a non-object notification payload", () => {
    const value = { ...validEnvelope(), notification: [1, 2] };
    expect(() => assertNotificationEnvelope(value)).toThrow("notification");
  });

  it("rejects non-object top levels", () => {
    for (const value of [null, "text", 7, ["a"]]) {
      expect(() => assertNotificationEnvelope(value)).toThrow(
        "expected an object",
      );
    }
  });

  it("includes the source in errors", () => {
    expect(() => assertNotificationEnvelope(null, "req#42")).toThrow("req#42");
  });
});

describe("parseNotificationEnvelope", () => {
  it("parses a string body", () => {
    const envelope = parseNotificationEnvelope(JSON.stringify(validEnvelope()));
    expect(envelope.notification_type).toBe("transactions.inbound");
  });

  it("parses a byte body — the same raw value verification runs on", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(validEnvelope()));
    const envelope = parseNotificationEnvelope(bytes);
    expect(envelope.notification_id).toBe(
      "5f4d63f1-2a80-4b45-a342-31b1b09a5cbf",
    );
  });

  it("throws a sourced error on malformed JSON", () => {
    expect(() => parseNotificationEnvelope("{not json", "req#7")).toThrow(
      /req#7.*malformed JSON/,
    );
  });
});
