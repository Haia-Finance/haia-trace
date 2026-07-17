import { describe, expect, it } from "vitest";

import { CORE_PLACEHOLDER } from "./index.js";

describe("@usehaia/trace-core", () => {
  it("exposes the placeholder marker", () => {
    expect(CORE_PLACEHOLDER).toBe("trace-core-ready");
  });
});
