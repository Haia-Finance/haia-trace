import {
  createRecorder,
  type EventWriter,
  type TraceEvent,
} from "@usehaia/trace-core";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
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

/** Read a real SDK instance's hook registry — the array it fires on each event. */
const handlersOf = (
  instance: object,
  field: string,
): ((context: unknown) => unknown)[] =>
  (instance as Record<string, ((context: unknown) => unknown)[]>)[field] ?? [];

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
const ROUTES = {
  "/report": {
    accepts: {
      scheme: "exact",
      payTo: "0xseller",
      price: "$0.01",
      network: "eip155:84532",
    },
  },
} as const;
const RESOURCE = {
  url: "https://api.example.com/report",
  description: "Quarterly report",
  mimeType: "application/json",
  serviceName: "example",
  iconUrl: "https://example.com/icon.png",
};
/**
 * One 402 offer. A factory, not a constant: the SDK decodes a fresh object per
 * 402 response and threads that one object through the pre-payment hooks, and
 * the adapter groups those hooks by its identity.
 */
const paymentRequired = () => ({
  x402Version: 2,
  resource: RESOURCE,
  accepts: [REQUIREMENTS],
});
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

describe("trace() on the real x402 SDK wrappers", () => {
  // The HTTP types are wrappers: each exposes one hook and keeps the instance
  // that owns the rest. Attaching to the wrapper alone captured a single hook —
  // no `x402.payment.submitted`, no settlement — while reporting `ok: true`.
  it("covers every client hook through the wrapped x402Client", () => {
    const client = new x402Client();
    const http = new x402HTTPClient(client);
    const { writer } = memoryWriter();

    const attestation = trace(http, { writer });

    expect(attestation.kind).toBe("httpClient");
    expect(attestation.complete).toBe(true);
    expect(attestation.missing).toEqual([]);
    expect(attestation.attached.sort()).toEqual(
      [
        "onPaymentRequired",
        "client.onBeforePaymentCreation",
        "client.onAfterPaymentCreation",
        "client.onPaymentCreationFailure",
        "client.onPaymentResponse",
      ].sort(),
    );
  });

  it("covers every server hook through the wrapped x402ResourceServer", () => {
    const http = new x402HTTPResourceServer(new x402ResourceServer(), ROUTES);
    const { writer } = memoryWriter();

    const attestation = trace(http, { writer });

    expect(attestation.kind).toBe("httpResourceServer");
    expect(attestation.complete).toBe(true);
    expect(attestation.missing).toEqual([]);
    // Reached through the documented `server` getter.
    expect(attestation.attached).toContain("server.onAfterSettle");
    expect(attestation.attached).toContain("onProtectedRequest");
  });

  it("records the wrapped instance's firings under the wrapper's role", () => {
    const server = new x402ResourceServer();
    const http = new x402HTTPResourceServer(server, ROUTES);
    const { writer, events } = memoryWriter();
    trace(http, { writer });

    // Fire the real registry: the SDK invokes every registered hook in order.
    for (const hook of handlersOf(server, "beforeVerifyHooks")) {
      hook({
        paymentPayload: paymentPayload("0x01"),
        requirements: REQUIREMENTS,
      });
    }

    expect(payments(events).map((event) => event.event_type)).toEqual([
      "x402.verify.started",
    ]);
    expect(payments(events)[0]!.role).toBe("server");
  });

  it("does not register twice when the wrapped instance is traced on its own", () => {
    const client = new x402Client();
    const http = new x402HTTPClient(client);
    const { writer } = memoryWriter();

    trace(http, { writer });
    const second = trace(client, { writer });

    // The inner client is already covered, so a direct trace() is the same no-op
    // a repeat call on the wrapper is — a second handler would double its events.
    expect(second.attached).toEqual(
      expect.arrayContaining(["client.onPaymentResponse"]),
    );
    expect(handlersOf(client, "paymentResponseHooks")).toHaveLength(1);
  });

  it("leaves a wrapper whose inner instance is unreachable honestly incomplete", () => {
    // A fork that renames the field matches no candidate: capture attaches what
    // it can and reports the rest as missing rather than looking connected.
    const { instance } = fakeInstance(["onProtectedRequest"]);
    const { writer } = memoryWriter();

    const attestation = trace(instance, { writer });

    expect(attestation.ok).toBe(true);
    expect(attestation.complete).toBe(false);
    expect(attestation.missing).toContain("onAfterSettle");
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

  it("reports the client's response by its outcome, not as a settlement", () => {
    // `x402.payment.responded` is the client-side witness a template reads as
    // "the payment settled", so only a successful settlement may carry it.
    const { instance, handlers } = fakeInstance(CLIENT_HOOKS);
    const { writer, events } = memoryWriter();
    trace(instance, { writer });

    const base = {
      paymentPayload: paymentPayload("0x01"),
      requirements: REQUIREMENTS,
    };
    const settle = (success: boolean) => ({
      success,
      transaction: success ? "0xtx" : "",
      network: "base-sepolia",
    });

    handlers.get("onPaymentResponse")!({
      ...base,
      settleResponse: settle(true),
    });
    handlers.get("onPaymentResponse")!({
      ...base,
      settleResponse: settle(false),
    });
    // Verification failed: the server answered with a fresh 402, no settlement.
    handlers.get("onPaymentResponse")!({
      ...base,
      paymentRequired: paymentRequired(),
    });
    // Transport or parse error: no settlement, no 402.
    handlers.get("onPaymentResponse")!({
      ...base,
      error: new Error("socket hung up"),
    });
    // Nothing the SDK's discriminant recognizes — never reported as settled.
    handlers.get("onPaymentResponse")!({ ...base });

    expect(payments(events).map((event) => event.event_type)).toEqual([
      "x402.payment.responded",
      "x402.settle.failed",
      "x402.verify.failed",
      "x402.payment.failed",
      "x402.payment.failed",
    ]);
  });

  it("reports an MCP paid call with no settlement as a failure", () => {
    const { instance, handlers } = fakeInstance([
      "onPaymentRequired",
      "onBeforePayment",
      "onAfterPayment",
    ]);
    const { writer, events } = memoryWriter();
    trace(instance, { writer });

    const base = {
      toolName: "get_report",
      paymentPayload: paymentPayload("0x01"),
    };
    handlers.get("onAfterPayment")!({
      ...base,
      settleResponse: {
        success: true,
        transaction: "0xtx",
        network: "base-sepolia",
      },
    });
    // The MCP client passes null when the paid call came back unsettled.
    handlers.get("onAfterPayment")!({ ...base, settleResponse: null });

    expect(payments(events).map((event) => event.event_type)).toEqual([
      "x402.payment.responded",
      "x402.payment.failed",
    ]);
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
    const offer = paymentRequired();
    handlers.get("onPaymentRequired")!({ paymentRequired: offer });
    handlers.get("onBeforePaymentCreation")!({
      paymentRequired: offer,
      selectedRequirements: REQUIREMENTS,
    });
    handlers.get("onAfterPaymentCreation")!({
      paymentRequired: offer,
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

  it("keeps two INTERLEAVED payments for the same resource fully apart", () => {
    // Two concurrent purchases of the same resource: byte-identical offers, so
    // only the identity of each 402 object separates them. Interleaved on
    // purpose — the pre-payment hooks of both are in flight at once.
    const { instance, handlers } = fakeInstance(CLIENT_HOOKS);
    const { writer, events } = memoryWriter();
    trace(instance, { writer });

    const a = { offer: paymentRequired(), payload: paymentPayload("0x0a") };
    const b = { offer: paymentRequired(), payload: paymentPayload("0x0b") };

    for (const payment of [a, b]) {
      handlers.get("onPaymentRequired")!({ paymentRequired: payment.offer });
    }
    for (const payment of [a, b]) {
      handlers.get("onAfterPaymentCreation")!({
        paymentRequired: payment.offer,
        selectedRequirements: REQUIREMENTS,
        paymentPayload: payment.payload,
      });
    }
    for (const payment of [a, b]) {
      handlers.get("onPaymentResponse")!({
        paymentPayload: payment.payload,
        requirements: REQUIREMENTS,
        settleResponse: {
          success: true,
          transaction: "0xtx",
          network: "base-sepolia",
        },
      });
    }

    // Each payment's three events land in its own operation — no event of one
    // payment is attributed to the other, and neither operation loses one.
    const byOperation = new Map<string | undefined, number>();
    for (const event of payments(events)) {
      byOperation.set(
        event.context_id,
        (byOperation.get(event.context_id) ?? 0) + 1,
      );
    }
    expect([...byOperation.entries()].sort()).toEqual([
      ["op-1", 3],
      ["op-2", 3],
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
      paymentRequired: paymentRequired(),
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

    // The firing is not silently lost: it leaves a line naming the hook, so the
    // gap is visible in the run even when no `onError` is supplied.
    expect(payments(events)).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      event_type: "trace.capture_failed",
      // A lone settle hook reads as a facilitator — it lacks the server-only
      // `onVerifiedPaymentCanceled`.
      role: "facilitator",
      payload: { hook: "onBeforeSettle" },
    });
    expect(events.at(-1)!.context_id).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("records an offer that arrives without its resource or accepts list", () => {
    // A v1 server's 402 body has no `resource` at all — a normalizer must never
    // be the reason a firing goes unrecorded.
    const { instance, handlers } = fakeInstance(["onPaymentRequired"]);
    const { writer, events } = memoryWriter();
    trace(instance, { writer });

    handlers.get("onPaymentRequired")!({
      paymentRequired: { x402Version: 1, error: "insufficient_funds" },
    });

    expect(payments(events)).toHaveLength(1);
    expect(payments(events)[0]).toMatchObject({
      event_type: "x402.payment.required",
      payload: { x402_version: 1, error: "insufficient_funds", accepts: [] },
    });
  });

  it("is a no-op when HAIA_TRACE_DISABLE=1", () => {
    process.env.HAIA_TRACE_DISABLE = "1";
    const { instance } = fakeInstance(SERVER_HOOKS);
    const { writer, events } = memoryWriter();

    const attestation = trace(instance, { writer });

    expect(attestation).toEqual({
      attached: [],
      missing: [],
      ok: false,
      complete: false,
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

    expect(attestation).toMatchObject({
      attached: ["onPaymentResponse"],
      ok: true,
      complete: false,
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
      missing: [],
      ok: false,
      complete: false,
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
    const inert = {
      attached: [],
      missing: [],
      ok: false,
      complete: false,
      kind: "unknown",
      role: "unknown",
    };
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
      missing: [],
      ok: false,
      complete: false,
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
      missing: [],
      ok: false,
      complete: false,
      kind: "unknown",
      role: "unknown",
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});
