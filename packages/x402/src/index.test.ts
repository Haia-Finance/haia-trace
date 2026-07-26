import {
  createRecorder,
  type EventWriter,
  type TraceEvent,
} from "@usehaia/trace-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetTraceSession, trace } from "./index.js";

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

/** An in-memory sink, so a test reads the events exactly as they were recorded. */
function memoryWriter() {
  const events: TraceEvent[] = [];
  const writer: EventWriter = {
    write: (event) => {
      events.push(event);
    },
    close: () => {},
  };
  return { writer, events };
}

/** The payment events of a run — the attestation line is not one of them. */
const payments = (events: TraceEvent[]): TraceEvent[] =>
  events.filter((event) => !event.event_type.startsWith("trace."));

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
const CLIENT_HOOKS = [
  "onPaymentRequired",
  "onBeforePaymentCreation",
  "onAfterPaymentCreation",
  "onPaymentCreationFailure",
  "onPaymentResponse",
];

const REQUIREMENTS = {
  scheme: "exact",
  network: "base-sepolia",
  asset: "0xUSDC",
  amount: "10000",
  payTo: "0xseller",
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};
const RESOURCE = {
  url: "https://api.example.com/report",
  description: "Quarterly report",
  mimeType: "application/json",
  serviceName: "example",
  iconUrl: "https://example.com/icon.png",
};
const PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: RESOURCE,
  accepts: [REQUIREMENTS],
};
/** A signed payload — `payload` holds exactly the material that must never be recorded. */
const paymentPayload = (nonce: string) => ({
  x402Version: 2,
  resource: RESOURCE,
  accepted: REQUIREMENTS,
  payload: {
    signature: "0xdeadbeefsignature",
    authorization: { from: "0xbuyer", to: "0xseller", nonce },
  },
});

beforeEach(() => {
  resetTraceSession();
});

afterEach(() => {
  delete process.env.HAIA_TRACE_DISABLE;
  vi.restoreAllMocks();
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
    // The instance looks like a server (has onVerifiedPaymentCanceled), but the
    // caller declares it a facilitator: the facilitator group is registered, so
    // the server-only onVerifiedPaymentCanceled is left alone.
    const { instance } = fakeInstance(SERVER_HOOKS);
    const { writer } = memoryWriter();

    const attestation = trace(instance, { kind: "facilitator", writer });

    expect(attestation.kind).toBe("facilitator");
    expect(attestation.role).toBe("facilitator");
    expect(attestation.attached).not.toContain("onVerifiedPaymentCanceled");
    expect(instance.onVerifiedPaymentCanceled).not.toHaveBeenCalled();
  });
});

describe("trace() event recording", () => {
  it("records a full TraceEvent per firing, stamped by the recorder", () => {
    const { instance, handlers } = fakeInstance(SERVER_HOOKS);
    const { writer, events } = memoryWriter();
    let id = 0;
    trace(instance, {
      writer,
      recorder: createRecorder({
        adapter: "trace-x402",
        now: () => "2026-01-01T00:00:00.000Z",
        newId: () => `id-${++id}`,
      }),
    });

    handlers.get("onBeforeVerify")!({
      paymentPayload: paymentPayload("0x01"),
      requirements: REQUIREMENTS,
    });

    const [event] = payments(events);
    expect(event).toMatchObject({
      event_id: "id-2",
      event_type: "x402.verify.started",
      occurred_at: "2026-01-01T00:00:00.000Z",
      seq: 1,
      adapter: "trace-x402",
      role: "server",
      context_id: "op-1",
    });
    expect(event!.payload).toEqual({
      x402_version: 2,
      resource: {
        url: RESOURCE.url,
        description: RESOURCE.description,
        mime_type: RESOURCE.mimeType,
        service_name: RESOURCE.serviceName,
      },
      requirements: {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0xUSDC",
        amount: "10000",
        pay_to: "0xseller",
        max_timeout_seconds: 60,
      },
    });
  });

  it("never records the signed payload, anywhere in the run", () => {
    const { instance, handlers } = fakeInstance(SERVER_HOOKS);
    const { writer, events } = memoryWriter();
    trace(instance, { writer });

    const payload = paymentPayload("0x01");
    handlers.get("onBeforeVerify")!({
      paymentPayload: payload,
      requirements: REQUIREMENTS,
    });
    handlers.get("onAfterSettle")!({
      paymentPayload: payload,
      requirements: REQUIREMENTS,
      result: { success: true, transaction: "0xtx", network: "base-sepolia" },
    });

    const recorded = JSON.stringify(events);
    expect(recorded).not.toContain("0xdeadbeefsignature");
    expect(recorded).not.toContain("authorization");
    // The allowlist also drops the scheme's open-ended `extra` bag.
    expect(recorded).not.toContain("USD Coin");
  });

  it("reads the outcome off the after-hooks instead of assuming success", () => {
    const { instance, handlers } = fakeInstance(SERVER_HOOKS);
    const { writer, events } = memoryWriter();
    trace(instance, { writer });

    const base = {
      paymentPayload: paymentPayload("0x01"),
      requirements: REQUIREMENTS,
    };
    handlers.get("onAfterVerify")!({
      ...base,
      result: { isValid: false, invalidReason: "insufficient_funds" },
    });
    handlers.get("onAfterSettle")!({
      ...base,
      result: {
        success: false,
        transaction: "",
        network: "base-sepolia",
        errorReason: "reverted",
      },
    });

    expect(payments(events).map((event) => event.event_type)).toEqual([
      "x402.verify.failed",
      "x402.settle.failed",
    ]);
    expect(payments(events)[0]!.payload.verify).toEqual({
      is_valid: false,
      invalid_reason: "insufficient_funds",
    });
  });

  it("records the attestation without a context_id, so it belongs to no receipt", () => {
    const { instance } = fakeInstance(FACILITATOR_HOOKS);
    const { writer, events } = memoryWriter();

    trace(instance, { writer });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "trace.attached",
      role: "facilitator",
      payload: { kind: "facilitator", attached: FACILITATOR_HOOKS },
    });
    expect(events[0]!.context_id).toBeUndefined();
  });
});

describe("trace() operation grouping", () => {
  it("gives one client payment a single context_id from 402 to settlement", () => {
    const { instance, handlers } = fakeInstance(CLIENT_HOOKS);
    const { writer, events } = memoryWriter();
    trace(instance, { writer });

    const payload = paymentPayload("0x01");
    handlers.get("onPaymentRequired")!({ paymentRequired: PAYMENT_REQUIRED });
    handlers.get("onBeforePaymentCreation")!({
      paymentRequired: PAYMENT_REQUIRED,
      selectedRequirements: REQUIREMENTS,
    });
    handlers.get("onAfterPaymentCreation")!({
      paymentRequired: PAYMENT_REQUIRED,
      selectedRequirements: REQUIREMENTS,
      paymentPayload: payload,
    });
    handlers.get("onPaymentResponse")!({
      paymentPayload: payload,
      requirements: REQUIREMENTS,
      settleResponse: {
        success: true,
        transaction: "0xtx",
        network: "base-sepolia",
      },
    });

    expect(payments(events).map((event) => event.event_type)).toEqual([
      "x402.payment.required",
      "x402.payment.creating",
      "x402.payment.submitted",
      "x402.payment.responded",
    ]);
    expect(new Set(payments(events).map((event) => event.context_id))).toEqual(
      new Set(["op-1"]),
    );
  });

  it("keeps two payments for the same resource in separate operations", () => {
    const { instance, handlers } = fakeInstance(CLIENT_HOOKS);
    const { writer, events } = memoryWriter();
    trace(instance, { writer });

    for (const nonce of ["0x01", "0x02"]) {
      handlers.get("onPaymentRequired")!({ paymentRequired: PAYMENT_REQUIRED });
      handlers.get("onAfterPaymentCreation")!({
        paymentRequired: PAYMENT_REQUIRED,
        selectedRequirements: REQUIREMENTS,
        paymentPayload: paymentPayload(nonce),
      });
    }

    expect(payments(events).map((event) => event.context_id)).toEqual([
      "op-1",
      "op-1",
      "op-2",
      "op-2",
    ]);
  });

  it("joins a client and a server traced in the same process on one operation", () => {
    const { writer, events } = memoryWriter();
    const { instance: client, handlers: clientHandlers } =
      fakeInstance(CLIENT_HOOKS);
    const { instance: server, handlers: serverHandlers } =
      fakeInstance(SERVER_HOOKS);
    trace(client, { writer });
    trace(server, { writer });

    const payload = paymentPayload("0x01");
    clientHandlers.get("onAfterPaymentCreation")!({
      paymentRequired: PAYMENT_REQUIRED,
      selectedRequirements: REQUIREMENTS,
      paymentPayload: payload,
    });
    serverHandlers.get("onBeforeVerify")!({
      paymentPayload: payload,
      requirements: REQUIREMENTS,
    });

    const [submitted, verifying] = payments(events);
    expect(submitted!.role).toBe("client");
    expect(verifying!.role).toBe("server");
    expect(verifying!.context_id).toBe(submitted!.context_id);
  });

  it("groups a protected request with its verify chain via the payment header", () => {
    const { instance, handlers } = fakeInstance([
      ...SERVER_HOOKS,
      "onProtectedRequest",
    ]);
    const { writer, events } = memoryWriter();
    trace(instance, { writer });

    const payload = paymentPayload("0x01");
    handlers.get("onProtectedRequest")!({
      method: "GET",
      path: "/report",
      routePattern: "/report",
      paymentHeader: btoa(JSON.stringify(payload)),
    });
    handlers.get("onBeforeVerify")!({
      paymentPayload: payload,
      requirements: REQUIREMENTS,
    });

    const [request, verifying] = payments(events);
    expect(request!.payload).toEqual({
      method: "GET",
      path: "/report",
      route_pattern: "/report",
      paid: true,
    });
    expect(verifying!.context_id).toBe(request!.context_id);
  });

  it("leaves an unpaid protected request out of every operation", () => {
    const { instance, handlers } = fakeInstance([
      ...SERVER_HOOKS,
      "onProtectedRequest",
    ]);
    const { writer, events } = memoryWriter();
    trace(instance, { writer });

    handlers.get("onProtectedRequest")!({ method: "GET", path: "/report" });

    const [request] = payments(events);
    expect(request!.payload.paid).toBe(false);
    expect(request!.context_id).toBeUndefined();
  });
});

describe("trace()", () => {
  it("is strictly passive: a throwing writer never escapes and the handler returns undefined", () => {
    const { instance, handlers } = fakeInstance(["onBeforeSettle"]);
    const onError = vi.fn();
    const writer: EventWriter = {
      write: () => {
        throw new Error("sink is down");
      },
      close: () => {},
    };
    trace(instance, { writer, onError });
    // trace() itself records a `trace.attached` event, which also throws; isolate
    // the handler firing so the assertion measures only that.
    onError.mockClear();

    const handler = handlers.get("onBeforeSettle")!;
    let returned: unknown = "sentinel";
    expect(() => {
      returned = handler({
        paymentPayload: paymentPayload("0x01"),
        requirements: REQUIREMENTS,
      });
    }).not.toThrow();

    expect(returned).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it("survives a context that does not match the hook's shape", () => {
    const { instance, handlers } = fakeInstance(["onBeforeSettle"]);
    const onError = vi.fn();
    const { writer, events } = memoryWriter();
    trace(instance, { writer, onError });

    expect(() => handlers.get("onBeforeSettle")!({})).not.toThrow();

    expect(payments(events)).toHaveLength(0);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("is a no-op when HAIA_TRACE_DISABLE=1", () => {
    process.env.HAIA_TRACE_DISABLE = "1";
    const { instance } = fakeInstance(SERVER_HOOKS);
    const { writer, events } = memoryWriter();

    const attestation = trace(instance, { writer });

    expect(attestation).toEqual({
      attached: [],
      ok: false,
      kind: "unknown",
      role: "unknown",
    });
    for (const name of SERVER_HOOKS) {
      expect(instance[name]).not.toHaveBeenCalled();
    }
    expect(events).toHaveLength(0);
  });

  it("is idempotent: a second trace() registers each hook only once", () => {
    const { instance } = fakeInstance(FACILITATOR_HOOKS);
    const { writer } = memoryWriter();

    const first = trace(instance, { writer });
    const second = trace(instance, { writer });

    expect(instance.onAfterSettle).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("stays idempotent on a frozen instance (marker never mutates the target)", () => {
    const { instance } = fakeInstance(FACILITATOR_HOOKS);
    Object.freeze(instance);
    const { writer } = memoryWriter();

    const first = trace(instance, { writer });
    const second = trace(instance, { writer });

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
    const { writer } = memoryWriter();

    const attestation = trace(callable, { writer });

    expect(attestation).toEqual({
      attached: ["onPaymentResponse"],
      ok: true,
      kind: "client",
      role: "client",
    });
    expect(callable.onPaymentResponse).toHaveBeenCalledTimes(1);
  });

  it("records a loud trace.attach_failed with kind unknown when no known hooks are present", () => {
    const { instance } = fakeInstance(["somethingElse"]);
    const { writer, events } = memoryWriter();

    const attestation = trace(instance, { writer });

    expect(attestation).toEqual({
      attached: [],
      ok: false,
      kind: "unknown",
      role: "unknown",
    });
    expect(events[0]).toMatchObject({
      event_type: "trace.attach_failed",
      role: "unknown",
      payload: { kind: "unknown", attached: [] },
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
    const { writer } = memoryWriter();

    const attestation = trace(instance, { writer });

    expect(attestation.kind).toBe("unknown");
    expect(attestation.attached).toEqual([]);
    expect(instance.onSomethingCustom).not.toHaveBeenCalled();
  });

  it("never lets a throwing writer escape while reporting attach_failed", () => {
    const { instance } = fakeInstance(["somethingElse"]);
    const onError = vi.fn();
    const writer: EventWriter = {
      write: () => {
        throw new Error("sink is down");
      },
      close: () => {},
    };

    let attestation: ReturnType<typeof trace> | undefined;
    // The unknown path still records a `trace.attach_failed` event; even if that
    // sink throws, trace() must not propagate it to the caller.
    expect(() => {
      attestation = trace(instance, { writer, onError });
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
