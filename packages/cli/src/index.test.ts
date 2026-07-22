import { describe, expect, it } from "vitest";

import { commands, listTemplates } from "./index.js";

describe("@usehaia/trace-cli surface", () => {
  it("re-exports the template loader", () => {
    // A smoke check that the core-backed loader is wired through the package entry.
    expect(listTemplates()).toContain("x402-payment");
  });

  it("exposes a non-empty command registry", () => {
    expect(commands.length).toBeGreaterThan(0);
    // Every registrar must be callable — the shape cli.ts relies on.
    for (const command of commands) {
      expect(typeof command.register).toBe("function");
    }
  });
});
