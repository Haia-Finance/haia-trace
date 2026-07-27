import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runSample, sampleCommand } from "./sample.js";

/** Run the sample and capture everything it printed. */
function sampleOutput(template?: string): string {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  runSample(template);
  return log.mock.calls.map((args) => args.join(" ")).join("\n");
}

describe("haia-trace sample", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assembles three buyer receipts — full, partial, exception", () => {
    const out = sampleOutput("x402-buyer");

    // One full happy path...
    expect(out).toContain("FULL");
    // ...one partial with the settlement gap explained...
    expect(out).toContain("PARTIAL");
    expect(out).toContain("no settlement response was observed");
    // ...and one with an observed settlement fault.
    expect(out).toContain("x402.settle.failed");
  });

  it("assembles three seller receipts — full, partial, exception", () => {
    const out = sampleOutput("x402-seller");

    expect(out).toContain("FULL");
    expect(out).toContain("PARTIAL");
    expect(out).toContain("settlement of the payment was not observed");
    expect(out).toContain("x402.verify.failed");
  });

  it("defaults to x402-buyer when no template is given", () => {
    expect(sampleOutput()).toContain("x402-buyer");
  });

  it("registers under the `sample` name on the program", () => {
    const program = new Command();
    sampleCommand.register(program);
    expect(program.commands.map((c) => c.name())).toContain("sample");
  });
});
