import { describe, expect, it } from "vitest";

import { X402_PLACEHOLDER } from "./index.js";

describe("@usehaia/trace-x402", () => {
  it("composes the marker from trace-core", () => {
    expect(X402_PLACEHOLDER).toBe("trace-core-ready/x402");
  });
});
