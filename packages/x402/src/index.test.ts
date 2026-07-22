import { afterEach, describe, expect, it, vi } from "vitest";

import { type TraceLogLine, trace } from "./index.js";

/**
 * A fake x402 instance: each named hook method is a `vi.fn()` that captures the
 * handler `trace()` registers, so tests can fire it and inspect the return value.
 * Methods are chainable (return the instance), like the real registrar API.
 */
function fakeInstance(hookNames: string[]) {
  const handlers = new Map<string, (context: unknown) => unknown>();
  const instance: Record<string, unknown> = {};
  for (const name of hookNames) {
    instance[name] = vi.fn((handler: (context: unknown) => unknown) => {
      handlers.set(name, handler);
      return instance;
    });
  }
  return { instance, handlers };
}

// The resource-server hook set — note `onVerifiedPaymentCanceled`, the method
// that distinguishes a server from a facilitator.
const SERVER_HOOKS = [
  "onBeforeVerify",
  "onAfterVerify",
  "onVerifyFailure",
  "onBeforeSettle",
  "onAfterSettle",
  "onSettleFailure",
  "onVerifiedPaymentCanceled",
];
// The facilitator shares the verify/settle names but has no onVerifiedPaymentCanceled.
const FACILITATOR_HOOKS = SERVER_HOOKS.filter(
  (h) => h !== "onVerifiedPaymentCanceled",
);

afterEach(() => {
  delete process.env.HAIA_TRACE_DISABLE;
  vi.restoreAllMocks();
});

describe("trace() kind inference", () => {
  it("infers a resource server (role: server) from onVerifiedPaymentCanceled", () => {
    const { instance } = fakeInstance([...SERVER_HOOKS, "unrelatedMethod"]);

    const attestation = trace(instance, { log: vi.fn() });

    expect(attestation.kind).toBe("resourceServer");
    expect(attestation.role).toBe("server");
    expect(attestation.attached.sort()).toEqual([...SERVER_HOOKS].sort());
    // Duck-typing must not touch methods outside the resolved kind's group.
    expect(instance.unrelatedMethod).not.toHaveBeenCalled();
  });

  it("infers a facilitator (role: facilitator) from verify/settle without onVerifiedPaymentCanceled", () => {
    const { instance } = fakeInstance(FACILITATOR_HOOKS);

    const attestation = trace(instance, { log: vi.fn() });

    expect(attestation.kind).toBe("facilitator");
    expect(attestation.role).toBe("facilitator");
    expect(attestation.attached.sort()).toEqual([...FACILITATOR_HOOKS].sort());
  });

  it("infers an http resource server (role: server) from onProtectedRequest", () => {
    const { instance } = fakeInstance([...SERVER_HOOKS, "onProtectedRequest"]);

    const attestation = trace(instance, { log: vi.fn() });

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

    const attestation = trace(instance, { log: vi.fn() });

    expect(attestation.kind).toBe("client");
    expect(attestation.role).toBe("client");
  });

  it("infers an http client (role: client) from onPaymentRequired without the MCP hooks", () => {
    const { instance } = fakeInstance(["onPaymentRequired"]);

    const attestation = trace(instance, { log: vi.fn() });

    expect(attestation.kind).toBe("httpClient");
    expect(attestation.role).toBe("client");
  });

  it("infers an MCP client (role: client) from onBeforePayment/onAfterPayment", () => {
    const { instance } = fakeInstance([
      "onPaymentRequired",
      "onBeforePayment",
      "onAfterPayment",
    ]);

    const attestation = trace(instance, { log: vi.fn() });

    expect(attestation.kind).toBe("mcpClient");
    expect(attestation.role).toBe("client");
    expect(attestation.attached.sort()).toEqual(
      ["onAfterPayment", "onBeforePayment", "onPaymentRequired"].sort(),
    );
  });

  it("tags the SAME hook name with different roles for server vs facilitator", () => {
    const serverLog = vi.fn();
    const { instance: server, handlers: serverHandlers } =
      fakeInstance(SERVER_HOOKS);
    trace(server, { log: serverLog });
    serverHandlers.get("onBeforeVerify")!({});

    const facLog = vi.fn();
    const { instance: fac, handlers: facHandlers } =
      fakeInstance(FACILITATOR_HOOKS);
    trace(fac, { log: facLog });
    facHandlers.get("onBeforeVerify")!({});

    const roleOf = (log: ReturnType<typeof vi.fn>) =>
      log.mock.calls
        .map((c) => c[0])
        .find((l: TraceLogLine) => l.hook === "onBeforeVerify")!.role;
    expect(roleOf(serverLog)).toBe("server");
    expect(roleOf(facLog)).toBe("facilitator");
  });
});

describe("trace() explicit kind override", () => {
  it("honors an explicit kind over inference and registers that kind's group", () => {
    // The instance looks like a server (has onVerifiedPaymentCanceled), but the
    // caller declares it a facilitator: the facilitator group is registered, so
    // the server-only onVerifiedPaymentCanceled is left alone.
    const { instance } = fakeInstance(SERVER_HOOKS);

    const attestation = trace(instance, { kind: "facilitator", log: vi.fn() });

    expect(attestation.kind).toBe("facilitator");
    expect(attestation.role).toBe("facilitator");
    expect(attestation.attached).not.toContain("onVerifiedPaymentCanceled");
    expect(instance.onVerifiedPaymentCanceled).not.toHaveBeenCalled();
  });
});

describe("trace()", () => {
  it("logs the raw context with the role under the hook name when a hook fires", () => {
    const { instance, handlers } = fakeInstance(SERVER_HOOKS);
    const log = vi.fn();
    trace(instance, { log });

    const context = {
      result: { transaction: "0xabc" },
      requirements: { amount: "1" },
    };
    handlers.get("onAfterVerify")!(context);

    expect(log).toHaveBeenCalledWith({
      hook: "onAfterVerify",
      role: "server",
      context,
    } satisfies TraceLogLine);
    // Passed through unchanged, not copied/normalized in this slice.
    expect(
      log.mock.calls.find((c) => c[0].hook === "onAfterVerify")![0].context,
    ).toBe(context);
  });

  it("is strictly passive: a throwing log never escapes and the handler returns undefined", () => {
    const { instance, handlers } = fakeInstance(["onBeforeSettle"]);
    const onError = vi.fn();
    const log = vi.fn(() => {
      throw new Error("sink is down");
    });
    trace(instance, { log, onError });
    // trace() itself logs a `trace.attached` line, which also throws; isolate the
    // handler firing so the assertion measures only that.
    onError.mockClear();

    const handler = handlers.get("onBeforeSettle")!;
    let returned: unknown = "sentinel";
    expect(() => {
      returned = handler({ requirements: {} });
    }).not.toThrow();

    expect(returned).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it("is a no-op when HAIA_TRACE_DISABLE=1", () => {
    process.env.HAIA_TRACE_DISABLE = "1";
    const { instance } = fakeInstance(SERVER_HOOKS);
    const log = vi.fn();

    const attestation = trace(instance, { log });

    expect(attestation).toEqual({
      attached: [],
      ok: false,
      kind: "unknown",
      role: "unknown",
    });
    for (const name of SERVER_HOOKS) {
      expect(instance[name]).not.toHaveBeenCalled();
    }
    expect(log).not.toHaveBeenCalled();
  });

  it("is idempotent: a second trace() registers each hook only once", () => {
    const { instance } = fakeInstance(FACILITATOR_HOOKS);
    const log = vi.fn();

    const first = trace(instance, { log });
    const second = trace(instance, { log });

    expect(instance.onAfterSettle).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("stays idempotent on a frozen instance (marker never mutates the target)", () => {
    const { instance } = fakeInstance(FACILITATOR_HOOKS);
    Object.freeze(instance);
    const log = vi.fn();

    const first = trace(instance, { log });
    const second = trace(instance, { log });

    expect(first.kind).toBe("facilitator");
    expect(instance.onAfterVerify).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("attaches to a callable instance (function with hook methods)", () => {
    const handlers = new Map<string, unknown>();
    const callable = Object.assign(function callableClient() {}, {
      onPaymentResponse: vi.fn((fn: unknown) => {
        handlers.set("onPaymentResponse", fn);
      }),
    });
    const log = vi.fn();

    const attestation = trace(callable, { log });

    expect(attestation).toEqual({
      attached: ["onPaymentResponse"],
      ok: true,
      kind: "client",
      role: "client",
    });
    expect(callable.onPaymentResponse).toHaveBeenCalledTimes(1);
  });

  it("emits a loud trace.attach_failed with kind unknown when no known hooks are present", () => {
    const { instance } = fakeInstance(["somethingElse"]);
    const log = vi.fn();

    const attestation = trace(instance, { log });

    expect(attestation).toEqual({
      attached: [],
      ok: false,
      kind: "unknown",
      role: "unknown",
    });
    expect(log).toHaveBeenCalledWith({
      hook: "trace.attach_failed",
      role: "unknown",
      context: { attached: [], kind: "unknown" },
    });
  });

  it("returns an inert attestation for non-object input without throwing", () => {
    const inert = { attached: [], ok: false, kind: "unknown", role: "unknown" };
    expect(trace(null)).toEqual(inert);
    expect(trace(undefined)).toEqual(inert);
    expect(trace(42)).toEqual(inert);
  });
});

describe("trace() with an out-of-contract kind override", () => {
  // Model a plain-JS caller (or a dynamically-computed string) passing a `kind`
  // that isn't one of the six canonical instance kinds — the type system can't
  // stop it, so trace() must handle it without throwing.
  const traceLoose = trace as (
    instance: unknown,
    options?: Record<string, unknown>,
  ) => ReturnType<typeof trace>;

  it("does not throw on an unrecognized kind string and falls back to inference", () => {
    const { instance } = fakeInstance(SERVER_HOOKS);

    let attestation: ReturnType<typeof trace> | undefined;
    expect(() => {
      // "server" is not a valid kind (the canonical name is "resourceServer").
      attestation = traceLoose(instance, { kind: "server", log: vi.fn() });
    }).not.toThrow();

    // The bad override is ignored; inference recognizes the resource server.
    expect(attestation!.kind).toBe("resourceServer");
    expect(attestation!.role).toBe("server");
  });

  it("does not throw on a prototype key like 'constructor'", () => {
    const { instance } = fakeInstance(FACILITATOR_HOOKS);

    let attestation: ReturnType<typeof trace> | undefined;
    expect(() => {
      attestation = traceLoose(instance, { kind: "constructor", log: vi.fn() });
    }).not.toThrow();

    expect(attestation!.kind).toBe("facilitator");
    expect(attestation!.role).toBe("facilitator");
  });
});

describe("trace() with an unresolvable kind (graceful, never throws)", () => {
  it("does not throw and attaches nothing for an object with no known hooks", () => {
    const { instance } = fakeInstance(["somethingElse", "anotherMethod"]);
    const log = vi.fn();

    let attestation: ReturnType<typeof trace> | undefined;
    expect(() => {
      attestation = trace(instance, { log });
    }).not.toThrow();

    expect(attestation).toEqual({
      attached: [],
      ok: false,
      kind: "unknown",
      role: "unknown",
    });
    // With no group to register, none of the instance's methods are treated as
    // registrars — the recorder leaves an unrecognized instance untouched.
    expect(instance.somethingElse).not.toHaveBeenCalled();
    expect(instance.anotherMethod).not.toHaveBeenCalled();
  });

  it("does not attach even to a lone verify/settle-adjacent name it doesn't recognize", () => {
    // `onSomethingCustom` is not one of the 15 known hooks, so the instance
    // resolves to `unknown` and nothing is registered.
    const { instance } = fakeInstance(["onSomethingCustom"]);
    const log = vi.fn();

    const attestation = trace(instance, { log });

    expect(attestation.kind).toBe("unknown");
    expect(attestation.attached).toEqual([]);
    expect(instance.onSomethingCustom).not.toHaveBeenCalled();
  });

  it("never lets a throwing log escape while reporting attach_failed", () => {
    const { instance } = fakeInstance(["somethingElse"]);
    const onError = vi.fn();
    const log = vi.fn(() => {
      throw new Error("sink is down");
    });

    let attestation: ReturnType<typeof trace> | undefined;
    // The unknown path still emits a `trace.attach_failed` line; even if that
    // sink throws, trace() must not propagate it to the caller.
    expect(() => {
      attestation = trace(instance, { log, onError });
    }).not.toThrow();

    expect(attestation).toEqual({
      attached: [],
      ok: false,
      kind: "unknown",
      role: "unknown",
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});
