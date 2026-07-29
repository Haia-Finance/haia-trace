/**
 * Placing an untyped instance into a kind — the duck-typing that decides which
 * hooks are registered and which role its events carry.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { hooksOf } from "../capture/registry.js";
import { resetTraceSession, trace } from "../index.js";
import {
  fakeInstance,
  memoryWriter,
  paymentPayload,
  payments,
  REQUIREMENTS,
} from "./testkit.js";

// From the adapter own map, so a suite can never cover fewer hooks than a kind
// exposes. The server set carries onVerifiedPaymentCanceled — the discriminant.
const SERVER_HOOKS = hooksOf("resourceServer");
const FACILITATOR_HOOKS = hooksOf("facilitator");

beforeEach(() => {
  resetTraceSession();
});

describe("trace() kind inference", () => {
  it("infers a resource server (role: server) from onVerifiedPaymentCanceled", () => {
    const { instance } = fakeInstance([...SERVER_HOOKS, "unrelatedMethod"]);
    const { writer } = memoryWriter();

    const attestation = trace(instance, { writer });

    expect(attestation.kind).toBe("resourceServer");
    expect(attestation.role).toBe("server");
    expect(attestation.attached.sort()).toEqual([...SERVER_HOOKS].sort());
    // Duck-typing must not touch methods outside the resolved kind's group.
    expect(instance.unrelatedMethod).not.toHaveBeenCalled();
  });

  it("infers a facilitator (role: facilitator) from verify/settle without onVerifiedPaymentCanceled", () => {
    const { instance } = fakeInstance(FACILITATOR_HOOKS);
    const { writer } = memoryWriter();

    const attestation = trace(instance, { writer });

    expect(attestation.kind).toBe("facilitator");
    expect(attestation.role).toBe("facilitator");
    expect(attestation.attached.sort()).toEqual([...FACILITATOR_HOOKS].sort());
  });

  it("infers an http resource server (role: server) from onProtectedRequest", () => {
    const { instance } = fakeInstance([...SERVER_HOOKS, "onProtectedRequest"]);
    const { writer } = memoryWriter();

    const attestation = trace(instance, { writer });

    expect(attestation.kind).toBe("httpResourceServer");
    expect(attestation.role).toBe("server");
    expect(attestation.attached).toContain("onProtectedRequest");
  });

  it("infers a client (role: client) from the payment-creation hooks", () => {
    const { instance } = fakeInstance([
      "onBeforePaymentCreation",
      "onAfterPaymentCreation",
      "onPaymentCreationFailure",
      "onPaymentResponse",
    ]);
    const { writer } = memoryWriter();

    const attestation = trace(instance, { writer });

    expect(attestation.kind).toBe("client");
    expect(attestation.role).toBe("client");
  });

  it("infers an http client (role: client) from onPaymentRequired without the MCP hooks", () => {
    const { instance } = fakeInstance(["onPaymentRequired"]);
    const { writer } = memoryWriter();

    const attestation = trace(instance, { writer });

    expect(attestation.kind).toBe("httpClient");
    expect(attestation.role).toBe("client");
    // A wrapper with no reachable inner client observes one hook of five, and
    // says so — `ok` alone would read as a connected recorder.
    expect(attestation.ok).toBe(true);
    expect(attestation.complete).toBe(false);
    expect(attestation.missing.sort()).toEqual(
      [
        "onAfterPaymentCreation",
        "onBeforePaymentCreation",
        "onPaymentCreationFailure",
        "onPaymentResponse",
      ].sort(),
    );
  });

  it("infers an MCP client (role: client) from onBeforePayment/onAfterPayment", () => {
    const { instance } = fakeInstance([
      "onPaymentRequired",
      "onBeforePayment",
      "onAfterPayment",
    ]);
    const { writer } = memoryWriter();

    const attestation = trace(instance, { writer });

    expect(attestation.kind).toBe("mcpClient");
    expect(attestation.role).toBe("client");
    expect(attestation.attached.sort()).toEqual(
      ["onAfterPayment", "onBeforePayment", "onPaymentRequired"].sort(),
    );
  });

  it("tags the SAME hook name with different roles for server vs facilitator", () => {
    const context = {
      paymentPayload: paymentPayload("0x01"),
      requirements: REQUIREMENTS,
    };

    const server = memoryWriter();
    const { instance: serverInstance, handlers: serverHandlers } =
      fakeInstance(SERVER_HOOKS);
    trace(serverInstance, { writer: server.writer });
    serverHandlers.get("onBeforeVerify")!(context);

    const facilitator = memoryWriter();
    const { instance: facInstance, handlers: facHandlers } =
      fakeInstance(FACILITATOR_HOOKS);
    trace(facInstance, { writer: facilitator.writer });
    facHandlers.get("onBeforeVerify")!(context);

    expect(payments(server.events)[0]!.role).toBe("server");
    expect(payments(facilitator.events)[0]!.role).toBe("facilitator");
  });
});

describe("trace() explicit kind override", () => {
  it("honors an explicit kind over inference and registers that kind's group", () => {
    // It looks like a server, but the caller declares it a facilitator: only the
    // facilitator group registers, leaving onVerifiedPaymentCanceled alone.
    const { instance } = fakeInstance(SERVER_HOOKS);
    const { writer } = memoryWriter();

    const attestation = trace(instance, { kind: "facilitator", writer });

    expect(attestation.kind).toBe("facilitator");
    expect(attestation.role).toBe("facilitator");
    expect(attestation.attached).not.toContain("onVerifiedPaymentCanceled");
    expect(instance.onVerifiedPaymentCanceled).not.toHaveBeenCalled();
  });
});

describe("trace() with an out-of-contract kind override", () => {
  // A plain-JS caller can pass any string; the type system cannot stop it, so
  // trace() must handle it without throwing.
  const traceLoose = trace as (
    instance: unknown,
    options?: Record<string, unknown>,
  ) => ReturnType<typeof trace>;

  it("does not throw on an unrecognized kind string and falls back to inference", () => {
    const { instance } = fakeInstance(SERVER_HOOKS);
    const { writer } = memoryWriter();

    let attestation: ReturnType<typeof trace> | undefined;
    expect(() => {
      // "server" is not a valid kind (the canonical name is "resourceServer").
      attestation = traceLoose(instance, { kind: "server", writer });
    }).not.toThrow();

    // The bad override is ignored; inference recognizes the resource server.
    expect(attestation!.kind).toBe("resourceServer");
    expect(attestation!.role).toBe("server");
  });

  it("does not throw on a prototype key like 'constructor'", () => {
    const { instance } = fakeInstance(FACILITATOR_HOOKS);
    const { writer } = memoryWriter();

    let attestation: ReturnType<typeof trace> | undefined;
    expect(() => {
      attestation = traceLoose(instance, { kind: "constructor", writer });
    }).not.toThrow();

    expect(attestation!.kind).toBe("facilitator");
    expect(attestation!.role).toBe("facilitator");
  });
});

describe("trace() with an unresolvable kind (graceful, never throws)", () => {
  it("does not throw and attaches nothing for an object with no known hooks", () => {
    const { instance } = fakeInstance(["somethingElse", "anotherMethod"]);
    const { writer } = memoryWriter();

    let attestation: ReturnType<typeof trace> | undefined;
    expect(() => {
      attestation = trace(instance, { writer });
    }).not.toThrow();

    expect(attestation).toEqual({
      attached: [],
      missing: [],
      ok: false,
      complete: false,
      kind: "unknown",
      role: "unknown",
    });
    // With no group to register, the recorder leaves the instance untouched.
    expect(instance.somethingElse).not.toHaveBeenCalled();
    expect(instance.anotherMethod).not.toHaveBeenCalled();
  });

  it("does not attach even to a lone verify/settle-adjacent name it doesn't recognize", () => {
    // Not one of the known hooks, so the kind resolves to `unknown`.
    const { instance } = fakeInstance(["onSomethingCustom"]);
    const { writer } = memoryWriter();

    const attestation = trace(instance, { writer });

    expect(attestation.kind).toBe("unknown");
    expect(attestation.attached).toEqual([]);
    expect(instance.onSomethingCustom).not.toHaveBeenCalled();
  });
});
