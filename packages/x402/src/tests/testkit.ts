/**
 * Shared test doubles and protocol fixtures for the adapter's suites.
 *
 * Every suite here needs the same two things — a fake x402 instance whose hooks
 * can be fired on demand, and a sink that reads back exactly what was recorded —
 * plus one set of protocol fixtures, so an expected payload is written once.
 *
 * Not shipped: `tsconfig.build.json` excludes `src/tests`, so nothing under it
 * reaches `dist/`.
 */

import type { EventWriter, TraceEvent } from "@usehaia/trace-core";
import { vi } from "vitest";

import { HOOKS_BY_KIND, type TraceInstanceKind } from "../hooks.js";
import { type TraceOptions, trace } from "../index.js";

/**
 * The hook names a kind exposes, read from the adapter's own map. A suite that
 * spelled the list out by hand would silently stop covering a hook the day one
 * is added.
 */
export const hooksOf = (kind: TraceInstanceKind): string[] => [
  ...HOOKS_BY_KIND[kind],
];

/**
 * A fake x402 instance: each named hook method is a `vi.fn()` that captures the
 * handler `trace()` registers, so a test can fire it and inspect the return
 * value. Methods are chainable (return the instance), like the real registrar API.
 */
export function fakeInstance(hookNames: readonly string[]) {
  const handlers = new Map<string, (context: unknown) => unknown>();
  const instance: Record<string, unknown> = {};
  for (const name of hookNames) {
    instance[name] = vi.fn((handler: (context: unknown) => unknown) => {
      handlers.set(name, handler);
      return instance;
    });
  }

  /** Invoke a registered handler the way the SDK would. */
  const fire = (hook: string, context: unknown): unknown => {
    const handler = handlers.get(hook);
    if (handler === undefined)
      throw new Error(`no handler registered for ${hook}`);
    return handler(context);
  };

  return { instance, handlers, fire };
}

/** An in-memory sink, so a test reads the events exactly as they were recorded. */
export function memoryWriter() {
  const events: TraceEvent[] = [];
  const writer: EventWriter = {
    write: (event) => {
      events.push(event);
    },
    close: () => {},
  };
  return { writer, events };
}

/** The payment events of a run — the `trace.*` attestation lines are not among them. */
export const payments = (events: readonly TraceEvent[]): TraceEvent[] =>
  events.filter((event) => !event.event_type.startsWith("trace."));

/** A traced fake of `kind`, with its hooks ready to fire and its run to read back. */
export function capture(kind: TraceInstanceKind, options: TraceOptions = {}) {
  const { instance, fire } = fakeInstance(hooksOf(kind));
  const { writer, events } = memoryWriter();
  const attestation = trace(instance, { writer, ...options });
  return { instance, fire, events, attestation };
}

/**
 * Fire one hook on a freshly traced instance and return the single payment event
 * it recorded — the shape most of the vocabulary suite is written against.
 */
export function recordOne(
  kind: TraceInstanceKind,
  hook: string,
  context: unknown,
): TraceEvent {
  const { fire, events } = capture(kind);
  fire(hook, context);
  const [event, ...rest] = payments(events);
  if (event === undefined) throw new Error(`${hook} recorded no payment event`);
  if (rest.length > 0)
    throw new Error(`${hook} recorded ${rest.length + 1} events, expected one`);
  return event;
}

// Protocol fixtures. Each carries at least one field outside the allowlist
// (`extra`, `iconUrl`, the signed `payload`), so any suite that records them
// also proves the redaction held.

export const REQUIREMENTS = {
  scheme: "exact",
  network: "base-sepolia",
  asset: "0xUSDC",
  amount: "10000",
  payTo: "0xseller",
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};

/** The same requirements once normalized — the expected shape in a payload. */
export const REQUIREMENTS_FACTS = {
  scheme: "exact",
  network: "base-sepolia",
  asset: "0xUSDC",
  amount: "10000",
  pay_to: "0xseller",
  max_timeout_seconds: 60,
};

export const RESOURCE = {
  url: "https://api.example.com/report",
  description: "Quarterly report",
  mimeType: "application/json",
  serviceName: "example",
  iconUrl: "https://example.com/icon.png",
};

/** The same resource once normalized. */
export const RESOURCE_FACTS = {
  url: RESOURCE.url,
  description: RESOURCE.description,
  mime_type: RESOURCE.mimeType,
  service_name: RESOURCE.serviceName,
};

/**
 * One 402 offer. A factory, not a constant: the SDK decodes a fresh object per
 * 402 response and threads that one object through the pre-payment hooks, and
 * the adapter groups those hooks by its identity.
 */
export const paymentRequired = () => ({
  x402Version: 2,
  resource: RESOURCE,
  accepts: [REQUIREMENTS],
});

/** A signed payload — `payload` holds exactly the material that must never be recorded. */
export const paymentPayload = (nonce: string) => ({
  x402Version: 2,
  resource: RESOURCE,
  accepted: REQUIREMENTS,
  payload: {
    signature: "0xdeadbeefsignature",
    authorization: { from: "0xbuyer", to: "0xseller", nonce },
  },
});

/** A settlement, successful or not. */
export const settleResponse = (success: boolean) => ({
  success,
  transaction: success ? "0xtx" : "",
  network: "base-sepolia",
  payer: "0xbuyer",
});
