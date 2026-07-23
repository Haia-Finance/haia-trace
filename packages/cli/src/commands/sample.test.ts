import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runSample, sampleCommand } from "./sample.js";

describe("haia-trace sample", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assembles three receipts from bundled fixtures — full, partial, exception", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    runSample("x402-payment");
    const out = log.mock.calls.map((args) => args.join(" ")).join("\n");

    // One full happy path...
    expect(out).toContain("FULL");
    // ...one partial with the paid_action gap explained...
    expect(out).toContain("PARTIAL");
    expect(out).toContain("the paid action's result was not observed");
    // ...and one with an observed settlement fault.
    expect(out).toContain("x402.settle.failed");
  });

  it("defaults to x402-payment when no template is given", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    runSample();
    const out = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(out).toContain("x402-payment");
  });

  it("registers under the `sample` name on the program", () => {
    const program = new Command();
    sampleCommand.register(program);
    expect(program.commands.map((c) => c.name())).toContain("sample");
  });
});
