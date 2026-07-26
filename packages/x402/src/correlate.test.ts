import { describe, expect, it } from "vitest";

import { createCorrelator } from "./correlate.js";

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

  it("carries the operation from the coarse stand-in onto the unique key", () => {
    const correlator = createCorrelator();

    const opened = correlator.resolve({ coarse: "resource:/report" });
    const paid = correlator.resolve({
      unique: "payment:1",
      coarse: "resource:/report",
    });
    const settled = correlator.resolve({ unique: "payment:1" });

    expect(paid).toBe(opened);
    expect(settled).toBe(opened);
  });

  it("retires the coarse key once a unique one takes over, so the next request is its own operation", () => {
    const correlator = createCorrelator();

    const first = correlator.resolve({ coarse: "resource:/report" });
    correlator.resolve({ unique: "payment:1", coarse: "resource:/report" });
    const second = correlator.resolve({ coarse: "resource:/report" });

    expect(second).not.toBe(first);
  });

  it("evicts least-recently-used keys past the cap", () => {
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
