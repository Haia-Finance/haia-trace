import { describe, expect, it } from "vitest";

import { listTemplates, loadTemplate, loadTemplateFile, parseTemplate } from "./index.js";

describe("template loading", () => {
  it("lists the templates shipped with the CLI", () => {
    expect(listTemplates()).toContain("x402-payment");
  });

  it("loads and validates the canonical x402-payment template", () => {
    const template = loadTemplate("x402-payment");
    expect(template.template).toBe("x402-payment");
    expect(template.stages.map((s) => s.id)).toEqual([
      "intent",
      "payment",
      "settlement",
      "paid_action",
      "business_record",
    ]);
    expect(template.exceptions).toContain("x402.verify.failed");
  });

  it("keeps the settlement match-set as an OR of witnesses", () => {
    const settlement = loadTemplate("x402-payment").stages.find((s) => s.id === "settlement");
    expect(settlement?.match.map((m) => m.event)).toEqual([
      "x402.payment.responded",
      "x402.settle.ok",
      "chain.transfer.confirmed",
    ]);
  });

  it("only lists templates that can be loaded by their listed name", () => {
    // listTemplates() and loadTemplate() share one bare-slug contract, so
    // enumerate-then-load never disagrees: every listed name resolves without a
    // spurious "not found".
    const names = listTemplates();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(() => loadTemplate(name)).not.toThrow();
    }
  });

  it("throws a clear error for an unknown template name", () => {
    expect(() => loadTemplate("does-not-exist")).toThrow(/template not found: does-not-exist/);
  });

  it("rejects a name that tries to escape the templates directory", () => {
    // A traversal name must be treated as unknown, never joined onto the path.
    expect(() => loadTemplate("../../../../etc/passwd")).toThrow(/template not found/);
    expect(() => loadTemplate("../secret")).toThrow(/template not found/);
  });

  it("rejects malformed template yaml", () => {
    // Valid yaml, but not a valid template (no stages) — must fail loudly.
    expect(() => parseTemplate("template: x\nversion: 1\n", "broken.yaml")).toThrow(
      /invalid template \(broken\.yaml\): `stages` must be a non-empty list/,
    );
  });

  it("attaches the source to a yaml syntax error", () => {
    expect(() => parseTemplate("stages: [unclosed", "bad.yaml")).toThrow(/invalid template \(bad\.yaml\)/);
  });

  it("reports a read error other than a missing file", () => {
    // Reading a directory ("." — the cwd) is an EISDIR, not a missing file, so it
    // must not be reported as "template not found".
    expect(() => loadTemplateFile(".")).toThrow(/could not read template/);
  });
});
