/**
 * What attaching does to an instance, and what it reports back.
 *
 * The wrapper cases run against the real x402 SDK classes: the shape they hold
 * their inner instance in is the thing capture has to follow, so a fake would
 * only prove the fake right.
 */

import type { EventWriter } from "@usehaia/trace-core";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetTraceSession, trace } from "../index.js";
import { hooksOf } from "../registry.js";
import {
  fakeInstance,
  memoryWriter,
  paymentPayload,
  payments,
  REQUIREMENTS,
} from "./testkit.js";

/** Read a real SDK instance's hook registry — the array it fires on each event. */
const handlersOf = (
  instance: object,
  field: string,
): ((context: unknown) => unknown)[] =>
  (instance as Record<string, ((context: unknown) => unknown)[]>)[field] ?? [];

const FACILITATOR_HOOKS = hooksOf("facilitator");

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

beforeEach(() => {
  resetTraceSession();
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe("attaching, whatever the instance is", () => {
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

describe("the attestation it records", () => {
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

describe("attaching is passive", () => {
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
});
