import { describe, expect, it } from "vitest";

import { CLI_PLACEHOLDER } from "./index.js";

describe("@usehaia/trace-cli", () => {
  it("composes the marker from trace-core", () => {
    expect(CLI_PLACEHOLDER).toBe("trace-core-ready/cli");
  });
});
