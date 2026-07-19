/**
 * `@usehaia/trace-x402` — passive recorder over the x402 v2 lifecycle hooks.
 * Hooks reference: https://docs.x402.org/advanced-concepts/lifecycle-hooks
 *
 * `trace(instance)` duck-typing-attaches to every lifecycle hook the instance
 * exposes and logs the raw context on each fire.
 *
 * Strictly passive — the load-bearing invariant. x402 lifecycle hooks can steer
 * the payment flow through their return value (`{ abort }`, `{ skip }`,
 * `{ recovered }`, …). Every handler here is wrapped in try/catch and ALWAYS
 * returns `undefined`, so the recorder can observe a payment but never alter it.
 *
 * ⚠️ No redaction yet: the raw-dump log can print signatures and credentials
 * straight from the hook context. This build is for local development and wiring
 * only — do not point it at a production or real-money flow until log output is
 * redacted.
 */

/**
 * Every method-based registrar hook across the six covered instance types —
 * x402Client, x402HTTPClient, x402ResourceServer, x402HTTPResourceServer,
 * x402Facilitator, x402MCPClient. Detection is pure duck-typing over these
 * names, so there is no `@x402/*` import (this package ships zero runtime
 * dependencies) and API-compatible forks are covered for free. x402MCPServer
 * registers hooks through a config object rather than these methods and is not
 * handled here.
 */
const KNOWN_HOOK_METHODS = [
  "onBeforePaymentCreation",
  "onAfterPaymentCreation",
  "onPaymentCreationFailure",
  "onPaymentResponse",
  "onPaymentRequired",
  "onBeforeVerify",
  "onAfterVerify",
  "onVerifyFailure",
  "onBeforeSettle",
  "onAfterSettle",
  "onSettleFailure",
  "onVerifiedPaymentCanceled",
  "onProtectedRequest",
  "onBeforePayment",
  "onAfterPayment",
] as const;

/** One recorded hook firing, as handed to the log sink. */
export interface TraceLogLine {
  hook: string;
  context: unknown;
}

export interface TraceOptions {
  /** Where each hook firing goes. Default: `console.log`. */
  log?: (line: TraceLogLine) => void;
  /** Observe recorder-internal errors (e.g. a throwing `log`). */
  onError?: (err: unknown) => void;
}

/**
 * What `trace()` connected to. Reporting this — rather than failing silently —
 * lets a caller tell "no payment events happened" apart from "the recorder never
 * wired up to this instance".
 */
export interface TraceAttestation {
  /** Hook methods that actually registered on the instance. */
  attached: string[];
  /** `attached.length > 0` — false means capture did not connect. */
  ok: boolean;
}

/**
 * Instances we have already attached to, mapped to the attestation from that
 * first attach so a repeat `trace()` returns it unchanged. A WeakMap (not a
 * property marker) is used deliberately: it never mutates the target, so
 * idempotency holds even for a frozen/sealed instance.
 */
const traced = new WeakMap<object, TraceAttestation>();

function isDisabled(): boolean {
  // `process` may be absent in browser/edge runtimes (where HTTP clients run);
  // reading it unguarded would throw ReferenceError straight out of trace().
  return typeof process !== "undefined" && process.env.HAIA_TRACE_DISABLE === "1";
}

function attestationFor(attached: string[]): TraceAttestation {
  return { attached, ok: attached.length > 0 };
}

/**
 * Attach the recorder to an x402 v2 instance and log on every lifecycle hook.
 *
 * Passive by construction: registered handlers only log and always return
 * `undefined`, so multi-registration alongside the user's own hooks never changes
 * the payment outcome. Idempotent per instance; a no-op when `HAIA_TRACE_DISABLE=1`.
 */
export function trace(instance: unknown, options: TraceOptions = {}): TraceAttestation {
  const log = options.log ?? ((line: TraceLogLine) => console.log("[trace-x402]", line));
  const onError = options.onError;

  if (isDisabled()) return attestationFor([]);
  // Accept objects and callable objects (an instance may be a function with hook
  // methods hanging off it); reject only null/undefined and primitives.
  if (instance === null || (typeof instance !== "object" && typeof instance !== "function")) {
    return attestationFor([]);
  }

  const target = instance as Record<string, unknown>;

  // Idempotency: a second trace() re-registers nothing and returns the first result.
  const existing = traced.get(target);
  if (existing) return existing;

  // Surface a recorder error without ever letting it — or a throwing onError —
  // reach the payment path.
  const reportError = (err: unknown): void => {
    try {
      onError?.(err);
    } catch {
      /* onError itself must not break the flow */
    }
  };
  const safeLog = (line: TraceLogLine): void => {
    try {
      log(line);
    } catch (err) {
      reportError(err);
    }
  };

  const attached: string[] = [];

  const makeLogger = (hook: string) => (context: unknown): undefined => {
    safeLog({ hook, context });
    return undefined;
  };

  for (const name of KNOWN_HOOK_METHODS) {
    const register = target[name];
    if (typeof register === "function") {
      try {
        // x402 hooks are chainable and support multiple registrations, so
        // adding our logger runs alongside — never displaces — the user's hooks.
        (register as (handler: (context: unknown) => undefined) => unknown).call(
          target,
          makeLogger(name),
        );
        attached.push(name);
      } catch (err) {
        reportError(err);
      }
    }
  }

  // Emit a visible line either way, so a failed attach is never mistaken for a
  // quiet run that simply saw no payment activity.
  safeLog({
    hook: attached.length > 0 ? "trace.attached" : "trace.attach_failed",
    context: { attached },
  });

  const result = attestationFor(attached);
  traced.set(target, result);
  return result;
}
