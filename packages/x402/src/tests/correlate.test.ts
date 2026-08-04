import { describe, expect, it, vi } from "vitest";

import { createCorrelator, paymentAttemptKey } from "../event/correlate.js";

describe("paymentAttemptKey", () => {
  const signed = (payload: Record<string, unknown>) => ({ payload });

  it("identifies an attempt by the authorization nonce", () => {
    expect(
      paymentAttemptKey(signed({ authorization: { nonce: "0x01" } })),
    ).toBe("payment:0x01");
  });

  it("falls back to a top-level nonce, then to the signature", () => {
    // Not every scheme nests its nonce, and some carry none at all — the
    // signature is then the only per-payment value on offer.
    expect(paymentAttemptKey(signed({ nonce: "0x02" }))).toBe("payment:0x02");
    expect(paymentAttemptKey(signed({ signature: "0xsig" }))).toBe(
      "payment:0xsig",
    );
  });

  it("yields no key when nothing identifies the attempt", () => {
    // A firing with no key is recorded without a `context_id` rather than
    // guessed into some operation.
    expect(paymentAttemptKey(undefined)).toBeUndefined();
    expect(
      paymentAttemptKey(signed({ authorization: { nonce: 42 } })),
    ).toBeUndefined();
    expect(paymentAttemptKey({})).toBeUndefined();
  });
});

/** Stands in for the `PaymentRequired` object the SDK threads through the hooks. */
const anchor = () => ({ resource: { url: "https://api.example.com/report" } });

/** uuidv4, the shape `crypto.randomUUID` returns. */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("createCorrelator", () => {
  it("returns no id when a firing offers no key", () => {
    const correlator = createCorrelator();

    expect(correlator.resolve({})).toBeUndefined();
  });

  it("groups every firing that shares a unique key", () => {
    const correlator = createCorrelator();

    const first = correlator.resolve({ unique: "payment:1" });
    const second = correlator.resolve({ unique: "payment:1" });

    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("keeps unrelated payments apart", () => {
    const correlator = createCorrelator();

    expect(correlator.resolve({ unique: "payment:1" })).not.toBe(
      correlator.resolve({ unique: "payment:2" }),
    );
  });

  it("mints a uuid, so an id is unique beyond the run it was minted in", () => {
    // Two correlators stand in for two runs of the same program. Their ids have
    // to differ even for the identical key: a Control Plane project stores every
    // run's events together and groups them by `context_id`, so a value that
    // restarted per run would merge payments that have nothing to do with each
    // other.
    const first = createCorrelator().resolve({ unique: "payment:1" });
    const second = createCorrelator().resolve({ unique: "payment:1" });

    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });

  it("carries the operation from the anchor onto the payment's nonce", () => {
    const correlator = createCorrelator();
    const offer = anchor();

    const opened = correlator.resolve({ anchor: offer });
    const paid = correlator.resolve({ unique: "payment:1", anchor: offer });
    const settled = correlator.resolve({ unique: "payment:1" });

    expect(paid).toBe(opened);
    expect(settled).toBe(opened);
  });

  it("keeps two concurrent payments for the same resource fully apart", () => {
    // The two offers are byte-identical — only their identity tells them apart,
    // which is exactly the case a content-derived key cannot handle.
    const correlator = createCorrelator();
    const a = anchor();
    const b = anchor();

    const aOpened = correlator.resolve({ anchor: a });
    const bOpened = correlator.resolve({ anchor: b });
    const aPaid = correlator.resolve({ unique: "payment:a", anchor: a });
    const bPaid = correlator.resolve({ unique: "payment:b", anchor: b });

    expect(aOpened).not.toBe(bOpened);
    expect(aPaid).toBe(aOpened);
    expect(bPaid).toBe(bOpened);
  });

  it("gives a fresh operation to the next purchase of the same resource", () => {
    const correlator = createCorrelator();

    const first = correlator.resolve({ anchor: anchor() });
    const second = correlator.resolve({ anchor: anchor() });

    expect(second).not.toBe(first);
  });

  it("evicts least-recently-used nonce keys past the cap", () => {
    const correlator = createCorrelator({ maxKeys: 2 });

    const first = correlator.resolve({ unique: "payment:1" });
    correlator.resolve({ unique: "payment:2" });
    const third = correlator.resolve({ unique: "payment:3" });

    // payment:1 was pushed out, so it opens a new operation rather than rejoining.
    expect(correlator.resolve({ unique: "payment:1" })).not.toBe(first);
    // payment:3 survived the cap with an id of its own — still there, and never
    // handed the id of a key it evicted.
    expect(correlator.resolve({ unique: "payment:3" })).toBe(third);
    expect(third).not.toBe(first);
  });

  it("uses an injected id source", () => {
    const ids = ["a", "b"];
    const correlator = createCorrelator({
      newContextId: () => ids.shift() ?? "exhausted",
    });

    expect(correlator.resolve({ unique: "payment:1" })).toBe("a");
    expect(correlator.resolve({ unique: "payment:2" })).toBe("b");
  });

  it("reads the uuid source per call, not once at import", async () => {
    // A runtime whose Web Crypto arrives as a polyfill — imported for its side
    // effect, so its order against this module's import is luck — must still mint
    // uuids. Imported with the global absent, exactly as that race leaves it, and
    // the polyfill lands before the first payment does.
    const { crypto } = globalThis;
    delete (globalThis as { crypto?: unknown }).crypto;
    try {
      vi.resetModules();
      const { createCorrelator: imported } = await import(
        "../event/correlate.js"
      );
      globalThis.crypto = crypto;

      expect(imported().resolve({ unique: "payment:1" })).toMatch(UUID_V4);
    } finally {
      globalThis.crypto = crypto;
      vi.resetModules();
    }
  });
});
