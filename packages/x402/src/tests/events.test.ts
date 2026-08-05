/**
 * The event vocabulary, pinned per hook. Written against the public `trace()`
 * rather than the mapper table, so it describes what a run contains.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { hooksOf } from "../capture/registry.js";
import type { TraceInstanceKind } from "../capture/spec.js";
import { resetTraceSession } from "../index.js";
import {
  capture,
  paymentAdapter,
  paymentPayload,
  paymentRequired,
  payments,
  REQUIREMENTS,
  REQUIREMENTS_FACTS,
  RESOURCE_FACTS,
  recordOne,
  settleResponse,
} from "./testkit.js";

const KINDS: TraceInstanceKind[] = [
  "client",
  "httpClient",
  "mcpClient",
  "resourceServer",
  "httpResourceServer",
  "facilitator",
];

/**
 * One canonical firing per hook. Built fresh per call: the pre-payment hooks
 * group by the *identity* of the offer object, so a shared one would silently
 * join unrelated operations.
 */
function firings(): Record<string, { context: unknown; event: string }> {
  const offer = paymentRequired();
  const payload = paymentPayload("0x01");
  const attempt = { paymentPayload: payload, requirements: REQUIREMENTS };

  return {
    onPaymentRequired: {
      context: { paymentRequired: offer },
      event: "x402.payment.required",
    },
    onBeforePaymentCreation: {
      context: { paymentRequired: offer, selectedRequirements: REQUIREMENTS },
      event: "x402.payment.creating",
    },
    onAfterPaymentCreation: {
      context: { paymentRequired: offer, paymentPayload: payload },
      event: "x402.payment.submitted",
    },
    onPaymentCreationFailure: {
      context: {
        paymentRequired: offer,
        selectedRequirements: REQUIREMENTS,
        error: new Error("no signer for base-sepolia"),
      },
      event: "x402.payment.creation_failed",
    },
    onPaymentResponse: {
      context: { ...attempt, settleResponse: settleResponse(true) },
      event: "x402.payment.responded",
    },
    onBeforePayment: {
      context: { toolName: "get_report", paymentRequired: offer },
      event: "x402.payment.requested",
    },
    onAfterPayment: {
      context: {
        toolName: "get_report",
        paymentPayload: payload,
        settleResponse: settleResponse(true),
      },
      event: "x402.payment.responded",
    },
    onProtectedRequest: {
      context: {
        method: "GET",
        path: "/report",
        routePattern: "/report",
        adapter: paymentAdapter(btoa(JSON.stringify(payload))),
      },
      event: "x402.request.protected",
    },
    onBeforeVerify: { context: attempt, event: "x402.verify.started" },
    onAfterVerify: {
      context: { ...attempt, result: { isValid: true, payer: "0xbuyer" } },
      event: "x402.verify.ok",
    },
    onVerifyFailure: {
      context: { ...attempt, error: new Error("facilitator unreachable") },
      event: "x402.verify.failed",
    },
    onBeforeSettle: { context: attempt, event: "x402.settle.started" },
    onAfterSettle: {
      context: { ...attempt, result: settleResponse(true) },
      event: "x402.settle.ok",
    },
    onSettleFailure: {
      context: { ...attempt, error: new Error("rpc timeout") },
      event: "x402.settle.failed",
    },
    onVerifiedPaymentCanceled: {
      context: {
        ...attempt,
        reason: "handler_threw",
        responseStatus: 500,
        error: new Error("handler blew up"),
      },
      event: "x402.payment.canceled",
    },
  };
}

beforeEach(() => {
  resetTraceSession();
});

describe("the event vocabulary", () => {
  it.each(KINDS)("maps every %s hook to its event type", (kind) => {
    const table = firings();

    for (const hook of hooksOf(kind)) {
      const firing = table[hook];
      // A hook with no entry here is a hook this suite stopped covering.
      expect(firing, `no canonical firing for ${hook}`).toBeDefined();
      expect(recordOne(kind, hook, firing?.context).event_type).toBe(
        firing?.event,
      );
    }
  });

  it("never records the signed payload, whichever hook fired", () => {
    // The redaction guarantee swept across the whole surface: the signed payload
    // is the credential that moves the money, `extra` / `iconUrl` the open bags.
    const recorded: unknown[] = [];
    for (const kind of KINDS) {
      const table = firings();
      const { fire, events } = capture(kind);
      for (const hook of hooksOf(kind)) fire(hook, table[hook]?.context);
      recorded.push(events);
    }

    const run = JSON.stringify(recorded);
    expect(run).not.toContain("0xdeadbeefsignature");
    expect(run).not.toContain("authorization");
    expect(run).not.toContain("USD Coin");
    expect(run).not.toContain("icon.png");
  });
});

describe("what a client records", () => {
  it("names the tool an MCP payment was for, and omits it off MCP", () => {
    const offer = paymentRequired();

    const mcp = recordOne("mcpClient", "onPaymentRequired", {
      paymentRequired: offer,
      toolName: "get_report",
    });
    const http = recordOne("httpClient", "onPaymentRequired", {
      paymentRequired: offer,
    });

    expect(mcp.payload.tool_name).toBe("get_report");
    expect(http.payload).not.toHaveProperty("tool_name");
  });

  it("records an MCP payment request as the offer plus the tool", () => {
    const event = recordOne("mcpClient", "onBeforePayment", {
      toolName: "get_report",
      paymentRequired: paymentRequired(),
    });

    expect(event.event_type).toBe("x402.payment.requested");
    expect(event.payload).toEqual({
      x402_version: 2,
      resource: RESOURCE_FACTS,
      accepts: [REQUIREMENTS_FACTS],
      tool_name: "get_report",
    });
  });

  it("explains a payment that could not be created", () => {
    const event = recordOne("httpClient", "onPaymentCreationFailure", {
      paymentRequired: paymentRequired(),
      selectedRequirements: REQUIREMENTS,
      error: new Error("no signer for base-sepolia"),
    });

    expect(event.payload).toEqual({
      x402_version: 2,
      resource: RESOURCE_FACTS,
      requirements: REQUIREMENTS_FACTS,
      error: { name: "Error", message: "no signer for base-sepolia" },
    });
  });

  it("reports the response by its outcome, not as a settlement", () => {
    // `x402.payment.responded` is the client-side witness a template reads as
    // "the payment settled", so only a successful settlement may carry it.
    const { fire, events } = capture("httpClient");
    const base = {
      paymentPayload: paymentPayload("0x01"),
      requirements: REQUIREMENTS,
    };

    fire("onPaymentResponse", {
      ...base,
      settleResponse: settleResponse(true),
    });
    fire("onPaymentResponse", {
      ...base,
      settleResponse: settleResponse(false),
    });
    // Verification failed: the server answered with a fresh 402, no settlement.
    fire("onPaymentResponse", { ...base, paymentRequired: paymentRequired() });
    // Transport or parse error: no settlement, no 402.
    fire("onPaymentResponse", { ...base, error: new Error("socket hung up") });
    // Nothing the SDK's discriminant recognizes — never reported as settled.
    fire("onPaymentResponse", { ...base });

    expect(payments(events).map((event) => event.event_type)).toEqual([
      "x402.payment.responded",
      "x402.settle.failed",
      "x402.verify.failed",
      "x402.payment.failed",
      "x402.payment.failed",
    ]);
  });

  it("reports a paid MCP call that came back unsettled as a failure", () => {
    const { fire, events } = capture("mcpClient");
    const base = {
      toolName: "get_report",
      paymentPayload: paymentPayload("0x01"),
    };

    fire("onAfterPayment", { ...base, settleResponse: settleResponse(true) });
    // The MCP client passes null when the paid call came back unsettled.
    fire("onAfterPayment", { ...base, settleResponse: null });

    expect(payments(events).map((event) => event.event_type)).toEqual([
      "x402.payment.responded",
      "x402.payment.failed",
    ]);
  });

  it("records an offer that arrives without its resource or accepts list", () => {
    // A v1 offer has no `resource` — a normalizer must never lose a firing.
    const event = recordOne("httpClient", "onPaymentRequired", {
      paymentRequired: { x402Version: 1, error: "insufficient_funds" },
    });

    expect(event).toMatchObject({
      event_type: "x402.payment.required",
      payload: { x402_version: 1, error: "insufficient_funds", accepts: [] },
    });
  });
});

describe("what a server records", () => {
  const attempt = () => ({
    paymentPayload: paymentPayload("0x01"),
    requirements: REQUIREMENTS,
  });

  it("reports a thrown verification fault with its cause", () => {
    const event = recordOne("resourceServer", "onVerifyFailure", {
      ...attempt(),
      error: new Error("facilitator unreachable"),
    });

    expect(event.event_type).toBe("x402.verify.failed");
    expect(event.payload.error).toEqual({
      name: "Error",
      message: "facilitator unreachable",
    });
  });

  it("reports a thrown settlement fault with its cause", () => {
    const event = recordOne("resourceServer", "onSettleFailure", {
      ...attempt(),
      error: new Error("rpc timeout"),
    });

    expect(event.event_type).toBe("x402.settle.failed");
    expect(event.payload.error).toEqual({
      name: "Error",
      message: "rpc timeout",
    });
  });

  it("records a rolled-back payment with why it was canceled", () => {
    // Verified, then rolled back because the paid work failed: a fault, not a
    // settlement.
    const event = recordOne("resourceServer", "onVerifiedPaymentCanceled", {
      ...attempt(),
      reason: "handler_threw",
      responseStatus: 500,
      error: new Error("handler blew up"),
    });

    expect(event.event_type).toBe("x402.payment.canceled");
    expect(event.payload).toMatchObject({
      reason: "handler_threw",
      response_status: 500,
      error: { name: "Error", message: "handler blew up" },
    });
  });

  it("prefers the context's own paymentHeader over the adapter", () => {
    // The SDK leaves the field unset today, but a transport that does fill it
    // must win over the adapter read.
    const event = recordOne("httpResourceServer", "onProtectedRequest", {
      method: "GET",
      path: "/report",
      paymentHeader: btoa(JSON.stringify(paymentPayload("0x01"))),
      adapter: paymentAdapter(),
    });

    expect(event.payload).toMatchObject({ paid: true });
    expect(event.context_id).toBeDefined();
  });

  it("still records a protected request whose payment header will not parse", () => {
    // The request is a fact either way; only its grouping is lost.
    const event = recordOne("httpResourceServer", "onProtectedRequest", {
      method: "GET",
      path: "/report",
      adapter: paymentAdapter(btoa("not json at all")),
    });

    expect(event.payload).toMatchObject({ paid: true });
    expect(event.context_id).toBeUndefined();
  });

  it("still records a protected request in a runtime without atob", () => {
    // `atob` is absent in some runtimes, so the header cannot be decoded there —
    // which costs grouping for this one event and nothing else.
    const { atob: decode } = globalThis;
    delete (globalThis as { atob?: unknown }).atob;
    try {
      const event = recordOne("httpResourceServer", "onProtectedRequest", {
        method: "GET",
        path: "/report",
        adapter: paymentAdapter("irrelevant-without-a-decoder"),
      });

      expect(event.payload).toMatchObject({ method: "GET", paid: true });
      expect(event.context_id).toBeUndefined();
    } finally {
      globalThis.atob = decode;
    }
  });

  it("records the settle facts, not just that settlement started", () => {
    const event = recordOne("resourceServer", "onBeforeSettle", attempt());

    expect(event.payload).toEqual({
      x402_version: 2,
      resource: RESOURCE_FACTS,
      requirements: REQUIREMENTS_FACTS,
    });
  });

  it("reads the outcome off the after-hooks instead of assuming success", () => {
    const { fire, events } = capture("resourceServer");
    const base = attempt();

    fire("onAfterVerify", {
      ...base,
      result: { isValid: false, invalidReason: "insufficient_funds" },
    });
    fire("onAfterSettle", {
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
});

describe("what a facilitator records", () => {
  it("reports a decline as a failure like the server, but explains it differently", () => {
    // A facilitator gets its clean "not valid" through onVerifyFailure, a server
    // through onAfterVerify. Both must land on x402.verify.failed so a template
    // reads them alike; only where the reason sits differs.
    const declined = {
      paymentPayload: paymentPayload("0x01"),
      requirements: REQUIREMENTS,
    };

    const facilitator = recordOne("facilitator", "onVerifyFailure", {
      ...declined,
      error: new Error("insufficient_funds"),
    });
    const server = recordOne("resourceServer", "onAfterVerify", {
      ...declined,
      result: { isValid: false, invalidReason: "insufficient_funds" },
    });

    expect(facilitator.event_type).toBe("x402.verify.failed");
    expect(server.event_type).toBe("x402.verify.failed");
    expect(facilitator.payload.error).toEqual({
      name: "Error",
      message: "insufficient_funds",
    });
    expect(server.payload.verify).toMatchObject({
      is_valid: false,
      invalid_reason: "insufficient_funds",
    });
  });

  it("tags the shared verify/settle hooks with its own role", () => {
    // Same six hook names as the server; only the role separates their events.
    const { fire, events } = capture("facilitator");
    fire("onAfterSettle", {
      paymentPayload: paymentPayload("0x01"),
      requirements: REQUIREMENTS,
      result: settleResponse(true),
    });

    const [event] = payments(events);
    expect(event?.event_type).toBe("x402.settle.ok");
    expect(event?.role).toBe("facilitator");
  });
});
