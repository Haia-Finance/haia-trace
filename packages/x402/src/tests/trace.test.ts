/**
 * `trace()` end to end: what a run actually contains once events are stamped,
 * grouped into operations, and written out.
 */

import { createRecorder } from "@usehaia/trace-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hooksOf } from "../capture/registry.js";
import { consoleWriter } from "../capture/session.js";
import { resetTraceSession, trace } from "../index.js";
import {
  fakeInstance,
  memoryWriter,
  paymentPayload,
  paymentRequired,
  payments,
  REQUIREMENTS,
  RESOURCE,
} from "./testkit.js";

const SERVER_HOOKS = hooksOf("resourceServer");
const CLIENT_HOOKS = hooksOf("httpClient");

beforeEach(() => {
  resetTraceSession();
});

afterEach(() => {
  delete process.env.HAIA_TRACE_DISABLE;
  vi.restoreAllMocks();
});

describe("the default sink", () => {
  it("writes one NDJSON line per event to stdout", () => {
    // The same encoding the file sink uses, so a run can simply be piped into a
    // file — which is only true if it really is one JSON object per line.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { instance, fire } = fakeInstance(SERVER_HOOKS);

    trace(instance);
    fire("onBeforeVerify", {
      paymentPayload: paymentPayload("0x01"),
      requirements: REQUIREMENTS,
    });

    const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines.map((e) => e.event_type)).toEqual([
      "trace.attached",
      "x402.verify.started",
    ]);
    expect(lines[0]).toMatchObject({ adapter: "trace-x402", role: "server" });
  });

  it("does not close stdout when the writer is closed", () => {
    // The default sink writes to a stream it does not own, so closing it has to
    // be a no-op rather than tearing down the host process's stdout.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { instance } = fakeInstance(SERVER_HOOKS);
    trace(instance);

    consoleWriter().close();

    console.log("still writable");
    expect(log).toHaveBeenLastCalledWith("still writable");
  });
});

describe("what a recorded run contains", () => {
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
      // The value is a uuid the correlator minted, so only its presence is
      // asserted here; `correlate.test.ts` covers what it is made of.
      context_id: expect.any(String),
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
    const operations = new Set(
      payments(events).map((event) => event.context_id),
    );
    expect(operations.size).toBe(1);
    expect([...operations][0]).toBeDefined();
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
    expect(byOperation.size).toBe(2);
    expect([...byOperation.keys()].every((id) => id !== undefined)).toBe(true);
    expect([...byOperation.values()]).toEqual([3, 3]);
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

describe("the off switch", () => {
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
});
