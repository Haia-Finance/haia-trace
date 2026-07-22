import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runTemplates, templatesCommand } from "./templates.js";

describe("haia-trace templates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the shipped templates", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    runTemplates();
    const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toContain("x402-payment");
  });

  it("registers under the `templates` name on the program", () => {
    const program = new Command();
    templatesCommand.register(program);
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("templates");
  });
});
