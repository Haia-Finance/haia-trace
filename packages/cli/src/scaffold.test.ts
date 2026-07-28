import { describe, expect, it } from "vitest";

import { parseTemplate, renderScaffold } from "./index.js";

describe("the starter template", () => {
  it("is a valid template — the file handed to a user always loads", () => {
    const template = parseTemplate(renderScaffold("my-op"), "scaffold");
    expect(template.template).toBe("my-op");
    expect(template.version).toBe(1);
  });

  it("carries the chosen name, not the placeholder", () => {
    expect(renderScaffold("refund-flow")).toContain("template: refund-flow");
  });

  it("quotes a name YAML would otherwise read as a number or a keyword", () => {
    // `42`, `true` and `null` are valid template names and valid file names, but
    // written as bare scalars they parse back as a number, a boolean and a null —
    // so the file the CLI just wrote would fail its own contract on the next read.
    for (const name of ["42", "true", "null", "0x1f", "1e3"]) {
      const template = parseTemplate(renderScaffold(name), "scaffold");
      expect(template.template).toBe(name);
    }
  });

  it("leaves an ordinary name unquoted, as the shipped templates are", () => {
    expect(renderScaffold("my-op")).toContain("\ntemplate: my-op\n");
  });

  it("explains every required stage, as the shipped templates do", () => {
    const template = parseTemplate(renderScaffold("my-op"), "scaffold");
    const required = template.stages.filter((s) => s.required);
    expect(required.length).toBeGreaterThan(0);
    for (const stage of required) {
      expect(stage.missing_explanation).toBeTruthy();
    }
  });

  it("shows both a milestone and a progress marker", () => {
    // The `required` distinction is the one thing a first-time author has to
    // understand, so the scaffold must demonstrate both sides of it.
    const stages = parseTemplate(renderScaffold("my-op"), "scaffold").stages;
    expect(stages.some((s) => s.required)).toBe(true);
    expect(stages.some((s) => !s.required)).toBe(true);
  });

  it("matches nothing real, so an unedited scaffold cannot yield a clean verdict", () => {
    const stages = parseTemplate(renderScaffold("my-op"), "scaffold").stages;
    for (const stage of stages) {
      for (const witness of stage.match) {
        expect(witness.event).toMatch(/^your\.namespace\./);
      }
    }
  });
});
