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
    expect(text).toContain("x402-facilitator");
    expect(text).toContain("3 templates available.");
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
    expect(text).toContain("4 templates available.");
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

describe("haia-trace template --dir", () => {
  it("scaffolds into <root>/templates and lists it back from there", () => {
    const root = join(dir, "my-trace");

    let path = "";
    output(() => {
      path = runTemplateNew("my-op", { dir: root });
    });

    expect(path).toBe(join(root, "templates", "my-op.yaml"));
    expect(readFileSync(path, "utf8")).toContain("template: my-op");
    const listed = output(() => runTemplateList({ dir: root }));
    expect(listed).toContain(path);
  });

  it("echoes --dir in the follow-up command when the root moved", () => {
    // The printed line has to be a command that actually resolves the file just
    // written — and the next `build` wants the same root, not just the same
    // templates, so the narrower flag would say the wrong thing here.
    const root = join(dir, "my-trace");
    const text = output(() => {
      runTemplateNew("my-op", { dir: root });
    });
    expect(text).toContain(`haia-trace build --template my-op --dir "${root}"`);
    expect(text).not.toContain("--templates-dir");
  });

  it("echoes --templates-dir instead when that is what moved", () => {
    const text = output(() => {
      runTemplateNew("my-op", { templatesDir: dir });
    });
    expect(text).toContain(
      `haia-trace build --template my-op --templates-dir "${dir}"`,
    );
  });

  it("echoes no directory flag at all under the default root", () => {
    // `.trace` is the default, so a bare command already resolves it. Run in a
    // temp cwd so the assertion is about the default, not this working directory.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const text = output(() => {
        runTemplateNew("my-op");
      });
      expect(text).toContain(join(".trace", "templates", "my-op.yaml"));
      expect(text).toContain("haia-trace build --template my-op\n");
    } finally {
      process.chdir(cwd);
    }
  });

  it("lets --templates-dir outrank --dir", () => {
    const root = join(dir, "my-trace");
    const shared = join(dir, "ops");

    let path = "";
    const text = output(() => {
      path = runTemplateNew("my-op", { dir: root, templatesDir: shared });
    });

    expect(path).toBe(join(shared, "my-op.yaml"));
    // Both flags moved a directory, so both have to survive into the suggestion.
    // Echoing only the narrower one would send the next `build` at the default
    // root — silently building another project's runs if one is on disk.
    expect(text).toContain(
      `haia-trace build --template my-op --dir "${root}" --templates-dir "${shared}"`,
    );
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
