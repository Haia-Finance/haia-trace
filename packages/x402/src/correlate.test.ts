import { describe, expect, it } from "vitest";

import { createCorrelator } from "./correlate.js";

/** Stands in for the `PaymentRequired` object the SDK threads through the hooks. */
const anchor = () => ({ resource: { url: "https://api.example.com/report" } });

describe("createCorrelator", () => {
  it("returns no id when a firing offers no key", () => {
    const correlator = createCorrelator();

    expect(correlator.resolve({})).toBeUndefined();
  });

  it("groups every firing that shares a unique key", () => {
    const correlator = createCorrelator();

    const first = correlator.resolve({ unique: "payment:1" });
    const second = correlator.resolve({ unique: "payment:1" });

    expect(first).toBe("op-1");
    expect(second).toBe(first);
  });

  it("keeps unrelated payments apart", () => {
    const correlator = createCorrelator();

    expect(correlator.resolve({ unique: "payment:1" })).toBe("op-1");
    expect(correlator.resolve({ unique: "payment:2" })).toBe("op-2");
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
    correlator.resolve({ unique: "payment:3" });

    // payment:1 was pushed out, so it opens a new operation rather than rejoining.
    expect(correlator.resolve({ unique: "payment:1" })).not.toBe(first);
    expect(correlator.resolve({ unique: "payment:3" })).toBe("op-3");
  });

  it("uses an injected id source", () => {
    const ids = ["a", "b"];
    const correlator = createCorrelator({
      newContextId: () => ids.shift() ?? "exhausted",
    });

    expect(correlator.resolve({ unique: "payment:1" })).toBe("a");
    expect(correlator.resolve({ unique: "payment:2" })).toBe("b");
  });
});
