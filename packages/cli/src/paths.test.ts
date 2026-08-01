import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_TRACE_DIR, traceDirs } from "./index.js";

describe("traceDirs", () => {
  it("puts everything under .trace by default", () => {
    expect(traceDirs()).toEqual({
      root: ".trace",
      events: join(".trace", "events"),
      receipts: join(".trace", "receipts"),
      templates: join(".trace", "templates"),
    });
    expect(DEFAULT_TRACE_DIR).toBe(".trace");
  });

  it("keeps the layout identical under a relocated root", () => {
    // The whole point of `--dir`: one flag moves the root and nothing else, so a
    // relocated directory is still readable by anyone who knows the default one.
    const moved = traceDirs(".my-trace");
    const home = traceDirs();
    expect(moved.root).toBe(".my-trace");
    for (const key of ["events", "receipts", "templates"] as const) {
      expect(moved[key]).toBe(home[key].replace(".trace", ".my-trace"));
    }
  });

  it("refuses an empty root rather than resolving it to the working directory", () => {
    // `--dir "$TRACE_ROOT"` with the variable unset arrives as "", and
    // join("", "templates") is "templates" — the layout would land loose in the
    // cwd, outside the .trace/… entries the gitignore guidance covers.
    for (const bad of ["", "   "]) {
      expect(() => traceDirs(bad)).toThrow(/non-empty path/);
    }
    // An *absent* root is a different thing, and still takes the default.
    expect(traceDirs(undefined).root).toBe(".trace");
  });

  it("accepts an absolute or nested root", () => {
    expect(traceDirs(join("build", "trace")).events).toBe(
      join("build", "trace", "events"),
    );
  });
});
