import { describe, expect, it } from "vitest";

import {
  listTemplates,
  loadTemplate,
  loadTemplateFile,
  parseTemplate,
} from "./index.js";

describe("template loading", () => {
  it("lists the templates shipped with the CLI", () => {
    expect(listTemplates()).toEqual(["escrow-arc", "x402-buyer", "x402-seller"]);
  });

  it("loads and validates the escrow-arc template", () => {
    const template = loadTemplate("escrow-arc");
    expect(template.template).toBe("escrow-arc");
    expect(template.stages.map((s) => s.id)).toEqual([
      "agreement",
      "terms_accepted",
      "deposit",
      "delivery",
      "criteria",
      "review",
      "disposition",
      "record",
    ]);
    // The optional stages: review is conditional, record is bookkeeping.
    expect(
      template.stages.filter((s) => !s.required).map((s) => s.id),
    ).toEqual(["review", "record"]);
    expect(template.exceptions).toEqual([
      "circle.transaction.outbound.failed",
      "circle.transaction.inbound.failed",
      "escrow.criteria.evaluation_failed",
    ]);
  });

  it("witnesses escrow money stages by contract events, not wallet transactions", () => {
    // An outbound wallet transaction toward the contract is ambiguous (a
    // deposit call and a release call look identical), so the deposit stage
    // must be closed only by the contract's own PaymentCreated.
    const template = loadTemplate("escrow-arc");
    const deposit = template.stages.find((s) => s.id === "deposit");
    expect(deposit?.match.map((m) => m.event)).toEqual([
      "circle.contract.payment_created",
    ]);
  });

  it("loads and validates the x402-buyer template", () => {
    const template = loadTemplate("x402-buyer");
    expect(template.template).toBe("x402-buyer");
    expect(template.stages.map((s) => s.id)).toEqual([
      "challenge",
      "payment",
      "settlement",
    ]);
    expect(template.stages.every((s) => s.required)).toBe(true);
    expect(template.exceptions).toEqual([
      "x402.payment.creation_failed",
      "x402.payment.failed",
      "x402.verify.failed",
      "x402.settle.failed",
      "x402.payment.canceled",
    ]);
  });

  it("gives every buyer stage a witness for every client kind", () => {
    // Per-kind flows from packages/x402/src/hooks.ts: the HTTP client emits
    // required/submitted/responded, the MCP client required/requested/responded,
    // the bare x402Client creating/submitted/responded. Each flow must close
    // every required stage, or that kind's clean payment assembles as partial.
    const flows = [
      [
        "x402.payment.required",
        "x402.payment.submitted",
        "x402.payment.responded",
      ],
      [
        "x402.payment.required",
        "x402.payment.requested",
        "x402.payment.responded",
      ],
      [
        "x402.payment.creating",
        "x402.payment.submitted",
        "x402.payment.responded",
      ],
    ];
    const template = loadTemplate("x402-buyer");
    for (const flow of flows) {
      for (const stage of template.stages.filter((s) => s.required)) {
        expect(
          stage.match.some((m) => flow.includes(m.event)),
          `stage ${stage.id} has no witness in flow ${flow.join(" → ")}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the buyer challenge match-set as an OR of the HTTP and bare-client witnesses", () => {
    const challenge = loadTemplate("x402-buyer").stages.find(
      (s) => s.id === "challenge",
    );
    expect(challenge?.match.map((m) => m.event)).toEqual([
      "x402.payment.required",
      "x402.payment.creating",
    ]);
  });

  it("closes the buyer settlement only on a successful client-side response", () => {
    const settlement = loadTemplate("x402-buyer").stages.find(
      (s) => s.id === "settlement",
    );
    expect(settlement?.match.map((m) => m.event)).toEqual([
      "x402.payment.responded",
    ]);
    expect(settlement?.missing_explanation).toMatch(/no settlement response/);
  });

  it("loads and validates the x402-seller template", () => {
    const template = loadTemplate("x402-seller");
    expect(template.template).toBe("x402-seller");
    expect(template.stages.map((s) => s.id)).toEqual([
      "request",
      "verification",
      "settlement",
    ]);
    expect(template.exceptions).toEqual([
      "x402.verify.failed",
      "x402.settle.failed",
      "x402.payment.canceled",
    ]);
  });

  it("keeps the seller request gate optional (only the HTTP server has one)", () => {
    const template = loadTemplate("x402-seller");
    expect(template.stages.map((s) => [s.id, s.required])).toEqual([
      ["request", false],
      ["verification", true],
      ["settlement", true],
    ]);
  });

  it("explains every required seller milestone that can go unclosed", () => {
    const template = loadTemplate("x402-seller");
    for (const stage of template.stages.filter((s) => s.required)) {
      expect(stage.missing_explanation).toBeTruthy();
    }
  });

  it("covers every failure event the x402 adapter can record", () => {
    // The failure vocabulary of packages/x402/src/events.ts. Each type must be an
    // exception in at least one shipped template, or an observed fault could
    // assemble into a clean-looking receipt.
    const adapterFailures = [
      "x402.payment.creation_failed",
      "x402.payment.failed",
      "x402.verify.failed",
      "x402.settle.failed",
      "x402.payment.canceled",
    ];
    const covered = new Set(
      listTemplates().flatMap((name) => loadTemplate(name).exceptions ?? []),
    );
    for (const failure of adapterFailures) {
      expect(covered).toContain(failure);
    }
  });

  it("matches only events the adapter can record — no invented witnesses", () => {
    // The success/progress vocabulary of packages/x402/src/events.ts. A stage
    // matching an event no adapter emits could never close.
    const adapterEvents = new Set([
      "x402.payment.required",
      "x402.payment.requested",
      "x402.payment.creating",
      "x402.payment.submitted",
      "x402.payment.responded",
      "x402.request.protected",
      "x402.verify.started",
      "x402.verify.ok",
      "x402.settle.started",
      "x402.settle.ok",
    ]);
    for (const name of listTemplates()) {
      for (const stage of loadTemplate(name).stages) {
        for (const witness of stage.match) {
          expect(adapterEvents).toContain(witness.event);
        }
      }
    }
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
    expect(() => loadTemplate("does-not-exist")).toThrow(
      /template not found: does-not-exist/,
    );
  });

  it("rejects a name that tries to escape the templates directory", () => {
    // A traversal name must be treated as unknown, never joined onto the path.
    expect(() => loadTemplate("../../../../etc/passwd")).toThrow(
      /template not found/,
    );
    expect(() => loadTemplate("../secret")).toThrow(/template not found/);
  });

  it("rejects malformed template yaml", () => {
    // Valid yaml, but not a valid template (no stages) — must fail loudly.
    expect(() =>
      parseTemplate("template: x\nversion: 1\n", "broken.yaml"),
    ).toThrow(
      /invalid template \(broken\.yaml\): `stages` must be a non-empty list/,
    );
  });

  it("attaches the source to a yaml syntax error", () => {
    expect(() => parseTemplate("stages: [unclosed", "bad.yaml")).toThrow(
      /invalid template \(bad\.yaml\)/,
    );
  });

  it("reports a read error other than a missing file", () => {
    // Reading a directory ("." — the cwd) is an EISDIR, not a missing file, so it
    // must not be reported as "template not found".
    expect(() => loadTemplateFile(".")).toThrow(/could not read template/);
  });
});
