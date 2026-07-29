import { describe, expect, it } from "vitest";

import {
  compact,
  normalizeError,
  normalizePaymentRequired,
  normalizeRequirements,
  normalizeResource,
  normalizeSettleResponse,
  normalizeVerifyResponse,
} from "../normalize.js";

describe("compact", () => {
  it("drops absent fields but keeps every falsy value that is present", () => {
    // Only `undefined` means "not provided"; the other falsy values are facts.
    expect(compact({ a: undefined, b: null, c: false, d: 0, e: "" })).toEqual({
      b: null,
      c: false,
      d: 0,
      e: "",
    });
  });
});

describe("normalizeResource", () => {
  it("renames to snake_case and keeps only the allowlisted fields", () => {
    const resource = {
      url: "https://api.example.com/report",
      description: "Quarterly report",
      mimeType: "application/json",
      serviceName: "example",
      iconUrl: "https://example.com/icon.png",
    };

    expect(normalizeResource(resource)).toEqual({
      url: resource.url,
      description: resource.description,
      mime_type: resource.mimeType,
      service_name: resource.serviceName,
    });
  });

  it("omits an optional field rather than recording it as null", () => {
    expect(
      normalizeResource({ url: "https://api.example.com/report" }),
    ).toEqual({ url: "https://api.example.com/report" });
  });

  it("passes an absent resource straight through", () => {
    expect(normalizeResource(undefined)).toBeUndefined();
  });
});

describe("normalizeRequirements", () => {
  it("keeps the payment's public terms and drops the scheme's `extra` bag", () => {
    const requirements = {
      scheme: "exact",
      network: "base-sepolia",
      asset: "0xUSDC",
      amount: "10000",
      payTo: "0xseller",
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    };

    expect(normalizeRequirements(requirements)).toEqual({
      scheme: "exact",
      network: "base-sepolia",
      asset: "0xUSDC",
      amount: "10000",
      pay_to: "0xseller",
      max_timeout_seconds: 60,
    });
  });
});

describe("an absent object", () => {
  it("normalizes to nothing at all, never to an empty record", () => {
    // An empty object would read like an observed fact.
    expect(normalizeRequirements(undefined)).toBeUndefined();
    expect(normalizeVerifyResponse(undefined)).toBeUndefined();
    expect(normalizePaymentRequired(undefined)).toBeUndefined();
  });
});

describe("normalizePaymentRequired", () => {
  it("normalizes the offer and every requirement it lists", () => {
    const offer = {
      x402Version: 2,
      resource: { url: "https://api.example.com/report", mimeType: "text/csv" },
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          asset: "0xUSDC",
          amount: "10000",
          payTo: "0xseller",
          maxTimeoutSeconds: 60,
        },
      ],
    };

    expect(normalizePaymentRequired(offer)).toEqual({
      x402_version: 2,
      resource: { url: offer.resource.url, mime_type: "text/csv" },
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          asset: "0xUSDC",
          amount: "10000",
          pay_to: "0xseller",
          max_timeout_seconds: 60,
        },
      ],
    });
  });

  it("tolerates an offer with neither a resource nor an accepts list", () => {
    // A v1 offer carries no `resource` — a normalizer must never lose a firing.
    expect(
      normalizePaymentRequired({ x402Version: 1, error: "insufficient_funds" }),
    ).toEqual({ x402_version: 1, error: "insufficient_funds", accepts: [] });
  });
});

describe("normalizeVerifyResponse", () => {
  it("records a decline with its reason", () => {
    expect(
      normalizeVerifyResponse({
        isValid: false,
        invalidReason: "insufficient_funds",
        invalidMessage: "balance too low",
        payer: "0xbuyer",
      }),
    ).toEqual({
      is_valid: false,
      invalid_reason: "insufficient_funds",
      invalid_message: "balance too low",
      payer: "0xbuyer",
    });
  });

  it("keeps `is_valid: false` rather than dropping it as falsy", () => {
    expect(normalizeVerifyResponse({ isValid: false })).toEqual({
      is_valid: false,
    });
  });
});

describe("normalizeSettleResponse", () => {
  it("records the transaction, the network and the payer", () => {
    expect(
      normalizeSettleResponse({
        success: true,
        transaction: "0xtx",
        network: "base-sepolia",
        amount: "10000",
        payer: "0xbuyer",
      }),
    ).toEqual({
      success: true,
      transaction: "0xtx",
      network: "base-sepolia",
      amount: "10000",
      payer: "0xbuyer",
    });
  });

  it("treats a null settlement as no settlement", () => {
    // The MCP client passes `null` when a paid call came back unsettled.
    expect(normalizeSettleResponse(null)).toBeUndefined();
    expect(normalizeSettleResponse(undefined)).toBeUndefined();
  });
});

describe("normalizeError", () => {
  it("keeps the name and message, never the stack", () => {
    const error = new TypeError("bad signature");

    expect(normalizeError(error)).toEqual({
      name: "TypeError",
      message: "bad signature",
    });
  });

  it("survives a non-Error throw without spreading its contents", () => {
    // `VerifiedPaymentCanceledContext.error` is typed `unknown`. `String()` on an
    // object yields `[object Object]`, which is the safe direction here.
    expect(normalizeError("plain string")).toEqual({
      name: "Error",
      message: "plain string",
    });
    expect(normalizeError({ secret: "0xkey" })).toEqual({
      name: "Error",
      message: "[object Object]",
    });
  });

  it("reports no error at all when there is none", () => {
    expect(normalizeError(undefined)).toBeUndefined();
    expect(normalizeError(null)).toBeUndefined();
  });
});

describe("the allowlist", () => {
  it("drops a field the x402 SDK adds in a later version", () => {
    // The load-bearing property: rebuilding field by field drops an unknown field
    // by default, where a denylist would leak it.
    const future = { futureField: "leaked" };
    const recorded = [
      normalizeResource({ url: "https://api.example.com", ...future }),
      normalizeRequirements({
        scheme: "exact",
        network: "base-sepolia",
        asset: "0xUSDC",
        amount: "1",
        payTo: "0xseller",
        maxTimeoutSeconds: 60,
        ...future,
      }),
      normalizePaymentRequired({ x402Version: 2, ...future }),
      normalizeVerifyResponse({ isValid: true, ...future }),
      normalizeSettleResponse({
        success: true,
        transaction: "0xtx",
        network: "base-sepolia",
        ...future,
      }),
    ];

    expect(JSON.stringify(recorded)).not.toContain("leaked");
  });
});
