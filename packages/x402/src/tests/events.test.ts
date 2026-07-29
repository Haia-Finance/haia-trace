/**
 * The event vocabulary, pinned per hook.
 *
 * Written against the public `trace()` rather than the mapper table, so it
 * describes what a run contains — not how the adapter is wired internally.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { resetTraceSession } from "../index.js";
import { hooksOf } from "../registry.js";
import type { TraceInstanceKind } from "../spec.js";
import {
  capture,
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
 * One canonical firing per hook — the context the SDK hands it, and the event it
 * must produce. Built fresh per call: the pre-payment hooks are grouped by the
 * *identity* of the offer object, so sharing one across tests would silently
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
        paymentHeader: btoa(JSON.stringify(payload)),
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
    // The redaction guarantee, swept across the whole surface rather than one
    // hook: `payload` is the credential that moves the money, and `extra` /
    // `iconUrl` are the open-ended fields the allowlist drops.
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
    // A payment that verified but was rolled back because the paid work did not
    // complete — the receipt has to show it as a fault, not as a settlement.
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

  it("records the settle facts, not just that settlement started", () => {
    const event = recordOne("resourceServer", "onBeforeSettle", attempt());

    expect(event.payload).toEqual({
      x402_version: 2,
      resource: RESOURCE_FACTS,
      requirements: REQUIREMENTS_FACTS,
    });
  });
});

describe("what a facilitator records", () => {
  it("tags the shared verify/settle hooks with its own role", () => {
    // The server and the facilitator expose the same six hook names; only the
    // role separates their events.
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
