import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTemplate } from "../templates.js";
import {
  runTemplateList,
  runTemplateNew,
  templateCommand,
} from "./template.js";

let dir: string;

/** Run a command with `console.log` captured, and return everything it printed. */
function output(run: () => void): string {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  run();
  return log.mock.calls.map((call) => call.join(" ")).join("\n");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-template-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("haia-trace template list", () => {
  it("lists the built-in templates", () => {
    const text = output(() => runTemplateList({ templatesDir: dir }));
    expect(text).toContain("x402-buyer");
    expect(text).toContain("x402-seller");
    expect(text).toContain("built-in");
    expect(text).toContain("2 templates available.");
  });

  it("lists a project template by the path build would load it from", () => {
    const path = join(dir, "my-op.yaml");
    writeFileSync(
      path,
      "template: my-op\nversion: 1\nstages:\n  - id: only\n    required: true\n    match:\n      - event: local.only\n",
    );
    const text = output(() => runTemplateList({ templatesDir: dir }));
    expect(text).toContain("my-op");
    expect(text).toContain(path);
    expect(text).toContain("3 templates available.");
  });
});

describe("haia-trace template new", () => {
  it("writes a scaffold that resolves by the name it was given", () => {
    let path = "";
    const text = output(() => {
      path = runTemplateNew("my-op", { templatesDir: dir });
    });
    expect(path).toBe(join(dir, "my-op.yaml"));
    expect(text).toContain(path);

    // The round trip is the point of the command: what `new` writes is exactly
    // what `build --template my-op` will pick up.
    expect(resolveTemplate("my-op", dir).template).toBe("my-op");
  });

  it("suggests a build command that resolves what it just wrote", () => {
    // With a non-default directory the bare suggestion would not find the file,
    // so the flag has to travel with it.
    const text = output(() => {
      runTemplateNew("my-op", { templatesDir: dir });
    });
    expect(text).toContain(`haia-trace build --template my-op --templates-dir`);
    expect(text).toContain(dir);
  });

  it("creates the templates directory when it does not exist yet", () => {
    const nested = join(dir, "a", "b");
    output(() => {
      runTemplateNew("my-op", { templatesDir: nested });
    });
    expect(readFileSync(join(nested, "my-op.yaml"), "utf8")).toContain(
      "template: my-op",
    );
  });

  it("refuses to overwrite an existing template", () => {
    output(() => {
      runTemplateNew("my-op", { templatesDir: dir });
    });
    expect(() => runTemplateNew("my-op", { templatesDir: dir })).toThrow(
      /template already exists.*--force/s,
    );
  });

  it("overwrites with --force, leaving the edited file behind", () => {
    const path = join(dir, "my-op.yaml");
    writeFileSync(path, "# hand-edited\n");
    output(() => {
      runTemplateNew("my-op", { templatesDir: dir, force: true });
    });
    expect(readFileSync(path, "utf8")).not.toContain("hand-edited");
  });

  it("rejects a name that could not be resolved later", () => {
    // The same bare-slug contract the loaders use — and the reason a name can
    // never write outside the templates directory.
    expect(() => runTemplateNew("../escape", { templatesDir: dir })).toThrow(
      /invalid template name/,
    );
    expect(() => runTemplateNew("has space", { templatesDir: dir })).toThrow(
      /invalid template name/,
    );
  });

  it("says so when the new template shadows a built-in", () => {
    const text = output(() => {
      runTemplateNew("x402-buyer", { templatesDir: dir });
    });
    expect(text).toMatch(/shadows the built-in/);
  });
});

describe("registration", () => {
  it("registers `template` with the `list` and `new` subcommands", () => {
    const program = new Command();
    templateCommand.register(program);

    const template = program.commands.find((c) => c.name() === "template");
    expect(template).toBeDefined();
    expect(template?.commands.map((c) => c.name()).sort()).toEqual([
      "list",
      "new",
    ]);
  });

  it("requires a subcommand — `template` alone has no action of its own", () => {
    // Commander shows the subcommand help for a parent with no action handler,
    // which is what makes a bare `haia-trace template` self-explaining.
    const program = new Command();
    templateCommand.register(program);
    const template = program.commands.find((c) => c.name() === "template");
    expect(template?.registeredArguments).toHaveLength(0);
  });
});
