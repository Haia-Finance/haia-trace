import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listAllTemplates,
  listLocalTemplates,
  listTemplates,
  loadTemplate,
  loadTemplateFile,
  parseTemplate,
  resolveTemplate,
  resolveTemplateSource,
} from "./index.js";

describe("template loading", () => {
  it("lists the templates shipped with the CLI", () => {
    expect(listTemplates()).toEqual([
      "escrow-arc",
      "x402-buyer",
      "x402-facilitator",
      "x402-seller",
    ]);
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
    expect(template.stages.filter((s) => !s.required).map((s) => s.id)).toEqual(
      ["review", "record"],
    );
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
    // Per-kind flows from packages/x402/src/roles/client/capture.ts: the HTTP client emits
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

  it("loads and validates the x402-facilitator template", () => {
    const template = loadTemplate("x402-facilitator");
    expect(template.template).toBe("x402-facilitator");
    expect(template.stages.map((s) => s.id)).toEqual([
      "verification",
      "settlement",
    ]);
    // No request gate and no cancellation exception: a facilitator has neither hook.
    expect(template.exceptions).toEqual([
      "x402.verify.failed",
      "x402.settle.failed",
    ]);
  });

  it("keeps the seller and the facilitator apart on their shared vocabulary", () => {
    // The two roles record the same verify/settle event types for the same
    // payment, so every witness in both templates has to name its role.
    for (const [name, role] of [
      ["x402-seller", "server"],
      ["x402-facilitator", "facilitator"],
    ] as const) {
      for (const stage of loadTemplate(name).stages) {
        for (const witness of stage.match) {
          expect(witness.role, `${name} / ${stage.id}`).toBe(role);
        }
      }
    }
  });

  it("covers every failure event the x402 adapter can record", () => {
    // The failure vocabulary of packages/x402/src/roles. Each type must be an
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
    // A stage matching an event no adapter emits could never close, so every
    // witness must come from a known emitter's vocabulary.
    // The success/progress vocabulary of packages/x402/src/roles:
    const x402Events = [
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
    ];
    // The trace-circle adapter's vocabulary (packages/circle/src/normalize.ts):
    const circleEvents = [
      "circle.transaction.inbound.complete",
      "circle.transaction.inbound.failed",
      "circle.transaction.outbound.complete",
      "circle.transaction.outbound.failed",
      "circle.contract.payment_created",
      "circle.contract.withdrawal",
      "circle.contract.refund",
    ];
    // The escrow demo backend's obligation vocabulary — emitted by the demo
    // service's own recorder, an adapter that lives outside this repo; the
    // escrow-arc template is the contract that fixes these names.
    const escrowBackendEvents = [
      "escrow.agreement.created",
      "escrow.terms.accepted",
      "escrow.work.delivered",
      "escrow.criteria.evaluated",
      "escrow.criteria.assessed",
      "escrow.criteria.evaluation_failed",
      "escrow.review.approved",
      "escrow.review.rejected",
      "escrow.record.reconciled",
    ];
    const adapterEvents = new Set([
      ...x402Events,
      ...circleEvents,
      ...escrowBackendEvents,
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

// A project's own templates: the same loading contract, applied to a directory the
// user owns rather than the one that ships inside the package.
describe("project templates", () => {
  // One stage, one witness — enough to be told apart from any shipped template.
  const LOCAL = `template: local
version: 1
stages:
  - id: only
    required: true
    match:
      - event: local.only
`;

  let dir: string;
  let templatesDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trace-templates-"));
    templatesDir = join(dir, "templates");
    mkdirSync(templatesDir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a project template by name", () => {
    writeFileSync(join(templatesDir, "my-op.yaml"), LOCAL);
    expect(
      resolveTemplate("my-op", templatesDir).stages.map((s) => s.id),
    ).toEqual(["only"]);
  });

  it("lets a project template shadow a built-in of the same name", () => {
    writeFileSync(join(templatesDir, "x402-buyer.yaml"), LOCAL);
    expect(
      resolveTemplate("x402-buyer", templatesDir).stages.map((s) => s.id),
    ).toEqual(["only"]);
  });

  it("falls back to the built-in set for a name the project has not authored", () => {
    writeFileSync(join(templatesDir, "my-op.yaml"), LOCAL);
    expect(
      resolveTemplate("x402-buyer", templatesDir).stages.map((s) => s.id),
    ).toEqual(["challenge", "payment", "settlement"]);
  });

  it("falls back when the project has no templates directory at all", () => {
    // The common case — most projects author none, so an absent directory must
    // read as "none of mine", never as an error.
    const absent = join(dir, "does-not-exist");
    expect(resolveTemplate("x402-buyer", absent).template).toBe("x402-buyer");
  });

  it("fails loudly on a malformed project template rather than falling back", () => {
    // The dangerous case: silently substituting the built-in would build a run
    // against a template the user did not write, and the receipt would look fine.
    writeFileSync(
      join(templatesDir, "x402-buyer.yaml"),
      "template: x402-buyer\nversion: 1\n",
    );
    expect(() => resolveTemplate("x402-buyer", templatesDir)).toThrow(
      /`stages` must be a non-empty list/,
    );
  });

  it("treats a reference that is not a bare name as a path", () => {
    const path = join(dir, "custom.yaml");
    writeFileSync(path, LOCAL);
    expect(resolveTemplate(path, templatesDir).template).toBe("local");
  });

  it("names both places searched when nothing resolves", () => {
    // A plain-string toThrow is a substring check, so a Windows path's
    // backslashes cannot be misread as regex escapes.
    expect(() => resolveTemplate("does-not-exist", templatesDir)).toThrow(
      `template not found: does-not-exist (looked in ${templatesDir}, then the templates shipped with the CLI)`,
    );
  });

  it("lists no project templates when the directory is absent", () => {
    expect(listLocalTemplates(join(dir, "does-not-exist"))).toEqual([]);
  });

  it("lists only project templates it could also load by the listed name", () => {
    writeFileSync(join(templatesDir, "my-op.yaml"), LOCAL);
    writeFileSync(join(templatesDir, "not.a.slug.yaml"), LOCAL);
    writeFileSync(join(templatesDir, "notes.md"), "");
    expect(listLocalTemplates(templatesDir)).toEqual(["my-op"]);
  });

  it("lists every resolvable name once, labelled with the file build would load", () => {
    writeFileSync(join(templatesDir, "my-op.yaml"), LOCAL);
    writeFileSync(join(templatesDir, "x402-buyer.yaml"), LOCAL);
    const all = listAllTemplates(templatesDir);

    // A shadowed built-in appears once, as the local file that wins.
    expect(all.map((t) => [t.name, t.origin])).toEqual([
      ["escrow-arc", "builtin"],
      ["my-op", "local"],
      ["x402-buyer", "local"],
      ["x402-facilitator", "builtin"],
      ["x402-seller", "builtin"],
    ]);
    expect(all[2]?.path).toBe(join(templatesDir, "x402-buyer.yaml"));
  });

  it("does not list a directory that happens to be named like a template", () => {
    // Listing it would promise a load that fails with EISDIR, breaking the
    // module's stated invariant that every listed name is loadable.
    mkdirSync(join(templatesDir, "archive.yaml"));
    expect(listLocalTemplates(templatesDir)).toEqual([]);
    expect(listAllTemplates(templatesDir).map((t) => t.name)).toEqual([
      "escrow-arc",
      "x402-buyer",
      "x402-facilitator",
      "x402-seller",
    ]);
  });

  it("reads a templates path that is a file, not a directory, as no templates", () => {
    // ENOTDIR, like ENOENT, means "no project templates here" — not a crash.
    const asFile = join(dir, "not-a-dir");
    writeFileSync(asFile, "");
    expect(listLocalTemplates(asFile)).toEqual([]);
  });

  it("reports the file a name resolves to, and where it came from", () => {
    writeFileSync(join(templatesDir, "my-op.yaml"), LOCAL);
    expect(resolveTemplateSource("my-op", templatesDir)).toMatchObject({
      name: "my-op",
      path: join(templatesDir, "my-op.yaml"),
      origin: "local",
    });
    expect(resolveTemplateSource("x402-seller", templatesDir)).toMatchObject({
      name: "x402-seller",
      origin: "builtin",
    });

    const path = join(dir, "custom.yaml");
    writeFileSync(path, LOCAL);
    expect(resolveTemplateSource(path, templatesDir)).toMatchObject({
      path,
      origin: "file",
    });
  });

  it("labels an origin by asking the filesystem, as the resolver does", () => {
    // On a case-insensitive filesystem `X402-Buyer.yaml` also answers to
    // `x402-buyer`, so a listing that compared name strings would call that name
    // built-in while `build` loaded the local file. Both must agree, on either
    // kind of filesystem.
    writeFileSync(join(templatesDir, "X402-Buyer.yaml"), LOCAL);
    for (const source of listAllTemplates(templatesDir)) {
      const resolved = resolveTemplateSource(source.name, templatesDir);
      expect(resolved.origin).toBe(source.origin);
      expect(resolved.path).toBe(source.path);
    }
  });

  it("agrees with the resolver — every listed name resolves to the listed origin", () => {
    writeFileSync(join(templatesDir, "my-op.yaml"), LOCAL);
    writeFileSync(join(templatesDir, "x402-buyer.yaml"), LOCAL);
    for (const source of listAllTemplates(templatesDir)) {
      const resolved = resolveTemplate(source.name, templatesDir);
      expect(resolved.template).toBe(
        source.origin === "local" ? "local" : source.name,
      );
    }
  });
});
