import { afterEach, describe, expect, it, vi } from "vitest";

import { trace, type TraceLogLine } from "./index.js";

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

const SERVER_HOOKS = [
  "onBeforeVerify",
  "onAfterVerify",
  "onVerifyFailure",
  "onBeforeSettle",
  "onAfterSettle",
  "onSettleFailure",
  "onVerifiedPaymentCanceled",
];

afterEach(() => {
  delete process.env.HAIA_TRACE_DISABLE;
  vi.restoreAllMocks();
});

describe("trace()", () => {
  it("registers every present hook and reports them in the attestation", () => {
    const { instance } = fakeInstance([...SERVER_HOOKS, "unrelatedMethod"]);
    const log = vi.fn();

    const attestation = trace(instance, { log });

    expect(attestation.ok).toBe(true);
    expect(attestation.attached.sort()).toEqual([...SERVER_HOOKS].sort());
    for (const name of SERVER_HOOKS) {
      expect(instance[name]).toHaveBeenCalledTimes(1);
    }
    // Duck-typing must not touch methods that aren't known hooks.
    expect(instance.unrelatedMethod).not.toHaveBeenCalled();
  });

  it("logs the raw context under the hook name when a hook fires", () => {
    const { instance, handlers } = fakeInstance(["onAfterVerify"]);
    const log = vi.fn();
    trace(instance, { log });

    const context = { result: { transaction: "0xabc" }, requirements: { amount: "1" } };
    handlers.get("onAfterVerify")!(context);

    expect(log).toHaveBeenCalledWith({ hook: "onAfterVerify", context } satisfies TraceLogLine);
    // Passed through unchanged, not copied/normalized in this slice.
    expect(log.mock.calls.find((c) => c[0].hook === "onAfterVerify")![0].context).toBe(context);
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

    expect(attestation).toEqual({ attached: [], ok: false });
    for (const name of SERVER_HOOKS) {
      expect(instance[name]).not.toHaveBeenCalled();
    }
    expect(log).not.toHaveBeenCalled();
  });

  it("is idempotent: a second trace() registers each hook only once", () => {
    const { instance } = fakeInstance(["onAfterSettle"]);
    const log = vi.fn();

    const first = trace(instance, { log });
    const second = trace(instance, { log });

    expect(instance.onAfterSettle).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("stays idempotent on a frozen instance (marker never mutates the target)", () => {
    const { instance } = fakeInstance(["onAfterVerify"]);
    Object.freeze(instance);
    const log = vi.fn();

    const first = trace(instance, { log });
    const second = trace(instance, { log });

    expect(first.attached).toEqual(["onAfterVerify"]);
    expect(instance.onAfterVerify).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("attaches to a callable instance (function with hook methods)", () => {
    const handlers = new Map<string, unknown>();
    const callable = Object.assign(
      function callableClient() {},
      {
        onPaymentResponse: vi.fn((fn: unknown) => {
          handlers.set("onPaymentResponse", fn);
        }),
      },
    );
    const log = vi.fn();

    const attestation = trace(callable, { log });

    expect(attestation).toEqual({ attached: ["onPaymentResponse"], ok: true });
    expect(callable.onPaymentResponse).toHaveBeenCalledTimes(1);
  });

  it("emits a loud trace.attach_failed when no known hooks are present", () => {
    const { instance } = fakeInstance(["somethingElse"]);
    const log = vi.fn();

    const attestation = trace(instance, { log });

    expect(attestation.ok).toBe(false);
    expect(attestation.attached).toEqual([]);
    expect(log).toHaveBeenCalledWith({ hook: "trace.attach_failed", context: { attached: [] } });
  });

  it("returns an inert attestation for non-object input without throwing", () => {
    expect(trace(null)).toEqual({ attached: [], ok: false });
    expect(trace(undefined)).toEqual({ attached: [], ok: false });
    expect(trace(42)).toEqual({ attached: [], ok: false });
  });
});
