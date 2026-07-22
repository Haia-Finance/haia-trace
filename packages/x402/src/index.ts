/**
 * `@usehaia/trace-x402` — passive recorder over the x402 v2 lifecycle hooks.
 * Hooks reference: https://docs.x402.org/advanced-concepts/lifecycle-hooks
 *
 * `trace(instance)` resolves the instance's kind (client, resource server,
 * facilitator, …), then duck-typing-attaches to that kind's lifecycle hooks and
 * logs the raw context on each fire, tagging every line with the observing
 * `role` (client / server / facilitator).
 *
 * The kind is inferred from the method set the instance exposes — no `@x402`
 * value is imported at runtime, so API-compatible forks are still covered and an
 * unrecognized shape degrades to role `"unknown"` rather than failing. A caller
 * can override the inference with `{ kind }`.
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

// Type-only imports of the x402 SDK's per-hook context interfaces. `import type`
// is erased by the compiler, so nothing is emitted into `dist/`: the package
// still ships zero runtime dependencies and never imports x402 at runtime. These
// only shape the context each handler is handed; detection stays pure duck-typing.
import type {
  // HTTP-client `onPaymentRequired` context; distinct from the MCP one below.
  PaymentRequiredContext as HttpPaymentRequiredContext,
  PaymentCreatedContext,
  PaymentCreationContext,
  PaymentCreationFailureContext,
  PaymentResponseContext,
} from "@x402/core/client";
import type {
  FacilitatorSettleContext,
  FacilitatorSettleFailureContext,
  FacilitatorSettleResultContext,
  FacilitatorVerifyContext,
  FacilitatorVerifyFailureContext,
  FacilitatorVerifyResultContext,
} from "@x402/core/facilitator";
import type { HTTPRequestContext } from "@x402/core/http";
import type {
  SettleContext,
  SettleFailureContext,
  SettleResultContext,
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyFailureContext,
  VerifyResultContext,
} from "@x402/core/server";
import type {
  // `onAfterPayment`'s context is an inline anonymous type in the SDK, not a
  // named export — recover it from the hook signature.
  AfterPaymentHook,
  // MCP-client `onPaymentRequired` context; distinct from the HTTP one above.
  PaymentRequiredContext as McpPaymentRequiredContext,
  PaymentRequestedContext,
} from "@x402/mcp";

// Per-instance hook groups: each of the six covered x402 instance types, mapped
// to the exact context the SDK hands each of its handlers. These are the source
// of truth — the flat `HookContextMap` below is derived from them, and the
// runtime method lists are keyed to them. Because a single instance is exactly
// one kind, each group is collision-free (unlike the merged map, where names
// shared across kinds become unions). The HTTP variants `extend` their base,
// mirroring how the SDK composes them.

/** x402Client. */
interface ClientHooks {
  onBeforePaymentCreation: PaymentCreationContext;
  onAfterPaymentCreation: PaymentCreatedContext;
  onPaymentCreationFailure: PaymentCreationFailureContext;
  onPaymentResponse: PaymentResponseContext;
}
/** x402HTTPClient — the client hooks plus the HTTP payment-required retry hook. */
interface HttpClientHooks extends ClientHooks {
  onPaymentRequired: HttpPaymentRequiredContext;
}
/** x402ResourceServer. */
interface ResourceServerHooks {
  onBeforeVerify: VerifyContext;
  onAfterVerify: VerifyResultContext;
  onVerifyFailure: VerifyFailureContext;
  onBeforeSettle: SettleContext;
  onAfterSettle: SettleResultContext;
  onSettleFailure: SettleFailureContext;
  onVerifiedPaymentCanceled: VerifiedPaymentCanceledContext;
}
/** x402HTTPResourceServer — the resource-server hooks plus the request gate. */
interface HttpResourceServerHooks extends ResourceServerHooks {
  onProtectedRequest: HTTPRequestContext;
}
/** x402Facilitator — same verify/settle hook names as the server, but its own
 *  context types, and (the discriminant) without `onVerifiedPaymentCanceled`. */
interface FacilitatorHooks {
  onBeforeVerify: FacilitatorVerifyContext;
  onAfterVerify: FacilitatorVerifyResultContext;
  onVerifyFailure: FacilitatorVerifyFailureContext;
  onBeforeSettle: FacilitatorSettleContext;
  onAfterSettle: FacilitatorSettleResultContext;
  onSettleFailure: FacilitatorSettleFailureContext;
}
/** x402MCPClient. (x402MCPServer registers via a config object, not these
 *  methods, and is out of scope.) */
interface McpClientHooks {
  onPaymentRequired: McpPaymentRequiredContext;
  onBeforePayment: PaymentRequestedContext;
  onAfterPayment: Parameters<AfterPaymentHook>[0];
}

/**
 * The flat hook → context map, derived from the per-instance groups above.
 * `trace()` duck-types over a single untyped instance and can't statically know
 * its kind, so a name shared by more than one kind (`onPaymentRequired`, and the
 * verify/settle hooks) is honestly a union here — the groups a key appears in,
 * unioned; groups it is absent from contribute `never`, which drops out.
 */
type Lookup<T, K extends PropertyKey> = K extends keyof T ? T[K] : never;
type HookName =
  | keyof HttpClientHooks
  | keyof HttpResourceServerHooks
  | keyof FacilitatorHooks
  | keyof McpClientHooks;
type HookContextMap = {
  [K in HookName]:
    | Lookup<HttpClientHooks, K>
    | Lookup<HttpResourceServerHooks, K>
    | Lookup<FacilitatorHooks, K>
    | Lookup<McpClientHooks, K>;
};

/** The x402 instance kinds `trace()` recognizes; `"unknown"` when inference
 *  can't place the instance (e.g. an unrelated fork). */
export type TraceKind =
  | "client"
  | "httpClient"
  | "resourceServer"
  | "httpResourceServer"
  | "facilitator"
  | "mcpClient"
  | "unknown";
/** A resolved, recognized kind — every kind except `"unknown"`. */
type TraceInstanceKind = Exclude<TraceKind, "unknown">;
/** The observing side of a payment, stamped on every recorded firing. */
export type TraceRole = "client" | "server" | "facilitator" | "unknown";

/** Every kind's role. A kind fixes the role for all of that instance's hooks. */
const ROLE_BY_KIND: Record<TraceKind, TraceRole> = {
  client: "client",
  httpClient: "client",
  mcpClient: "client",
  resourceServer: "server",
  httpResourceServer: "server",
  facilitator: "facilitator",
  unknown: "unknown",
};

// The runtime method-name list for each group, each proven exhaustive against
// its interface: `Record<keyof T, true>` forces every hook of the group to be
// listed (a missing key is a compile error) and rejects any stray name, so a
// list can never silently drift from its typed group.
const keysOf = <T>(record: Record<keyof T, true>): (keyof T)[] =>
  Object.keys(record) as (keyof T)[];

const CLIENT_METHODS = keysOf<ClientHooks>({
  onBeforePaymentCreation: true,
  onAfterPaymentCreation: true,
  onPaymentCreationFailure: true,
  onPaymentResponse: true,
});
const HTTP_CLIENT_METHODS = keysOf<HttpClientHooks>({
  onBeforePaymentCreation: true,
  onAfterPaymentCreation: true,
  onPaymentCreationFailure: true,
  onPaymentResponse: true,
  onPaymentRequired: true,
});
const RESOURCE_SERVER_METHODS = keysOf<ResourceServerHooks>({
  onBeforeVerify: true,
  onAfterVerify: true,
  onVerifyFailure: true,
  onBeforeSettle: true,
  onAfterSettle: true,
  onSettleFailure: true,
  onVerifiedPaymentCanceled: true,
});
const HTTP_RESOURCE_SERVER_METHODS = keysOf<HttpResourceServerHooks>({
  onBeforeVerify: true,
  onAfterVerify: true,
  onVerifyFailure: true,
  onBeforeSettle: true,
  onAfterSettle: true,
  onSettleFailure: true,
  onVerifiedPaymentCanceled: true,
  onProtectedRequest: true,
});
const FACILITATOR_METHODS = keysOf<FacilitatorHooks>({
  onBeforeVerify: true,
  onAfterVerify: true,
  onVerifyFailure: true,
  onBeforeSettle: true,
  onAfterSettle: true,
  onSettleFailure: true,
});
const MCP_CLIENT_METHODS = keysOf<McpClientHooks>({
  onPaymentRequired: true,
  onBeforePayment: true,
  onAfterPayment: true,
});

/** The hook set registered for each recognized kind. */
const HOOKS_BY_KIND: Record<
  TraceInstanceKind,
  readonly (keyof HookContextMap)[]
> = {
  client: CLIENT_METHODS,
  httpClient: HTTP_CLIENT_METHODS,
  resourceServer: RESOURCE_SERVER_METHODS,
  httpResourceServer: HTTP_RESOURCE_SERVER_METHODS,
  facilitator: FACILITATOR_METHODS,
  mcpClient: MCP_CLIENT_METHODS,
};

/** The recognized instance kinds, as a Set — used to validate a caller-supplied
 *  `kind` override before it is trusted to index `HOOKS_BY_KIND`. A Set (not an
 *  `in` check) so a prototype key like `"constructor"` can't slip through. */
const KNOWN_INSTANCE_KINDS = new Set<string>(Object.keys(HOOKS_BY_KIND));

/**
 * Infer an instance's kind from its method set, checked most-specific first.
 * The overlaps are deliberate: a resource server and a facilitator share the six
 * verify/settle hook names, so the server is identified by a method the
 * facilitator lacks (`onVerifiedPaymentCanceled`, or `onProtectedRequest` on the
 * HTTP server); an instance with verify/settle hooks but neither of those is the
 * facilitator. Purely structural — no `@x402` import, no reliance on class
 * identity — so forks and subclasses are placed the same way.
 *
 * The one inherent ambiguity: a resource server that does not expose
 * `onVerifiedPaymentCanceled` (a fork that renamed or dropped it) is
 * indistinguishable from a facilitator here and is read as one — its verify/settle
 * events would then be tagged `role: "facilitator"`. Pass an explicit `kind` to
 * correct such a case.
 */
function resolveKind(target: Record<string, unknown>): TraceKind {
  const has = (method: string): boolean => typeof target[method] === "function";
  if (has("onBeforePayment") || has("onAfterPayment")) return "mcpClient";
  if (has("onProtectedRequest")) return "httpResourceServer";
  if (has("onVerifiedPaymentCanceled")) return "resourceServer";
  if (FACILITATOR_METHODS.some(has)) return "facilitator";
  if (has("onPaymentRequired")) return "httpClient";
  if (CLIENT_METHODS.some(has)) return "client";
  return "unknown";
}

/** One recorded hook firing, as handed to the log sink. */
export interface TraceLogLine {
  hook: string;
  /** The observing side, fixed by the instance's resolved kind. */
  role: TraceRole;
  context: unknown;
}

export interface TraceOptions {
  /** Where each hook firing goes. Default: `console.log`. */
  log?: (line: TraceLogLine) => void;
  /** Observe recorder-internal errors (e.g. a throwing `log`). */
  onError?: (err: unknown) => void;
  /** Force the instance kind instead of inferring it from the method set. An
   *  unrecognized value is ignored (inference is used instead), and it only
   *  takes effect on the first `trace()` for a given instance — a repeat call is
   *  a no-op that returns the original attestation. */
  kind?: TraceInstanceKind;
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
  /** The resolved (or overridden) instance kind. */
  kind: TraceKind;
  /** The observing role implied by `kind`. */
  role: TraceRole;
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
  return (
    typeof process !== "undefined" && process.env.HAIA_TRACE_DISABLE === "1"
  );
}

/** An attestation for a run that never wired up (disabled, or non-instance input). */
function inertAttestation(): TraceAttestation {
  return { attached: [], ok: false, kind: "unknown", role: "unknown" };
}

/**
 * Attach the recorder to an x402 v2 instance and log on every lifecycle hook,
 * tagging each firing with the observing role.
 *
 * Passive by construction: registered handlers only log and always return
 * `undefined`, so multi-registration alongside the user's own hooks never changes
 * the payment outcome. Idempotent per instance; a no-op when `HAIA_TRACE_DISABLE=1`.
 */
export function trace(
  instance: unknown,
  options: TraceOptions = {},
): TraceAttestation {
  const log =
    options.log ?? ((line: TraceLogLine) => console.log("[trace-x402]", line));
  const onError = options.onError;

  if (isDisabled()) return inertAttestation();
  // Accept objects and callable objects (an instance may be a function with hook
  // methods hanging off it); reject only null/undefined and primitives.
  if (
    instance === null ||
    (typeof instance !== "object" && typeof instance !== "function")
  ) {
    return inertAttestation();
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

  // Resolve the kind once; it fixes the role for every hook and selects which
  // hook group to register. An explicit, recognized `kind` wins over inference.
  // An unrecognized override (a plain-JS caller, or a prototype key such as
  // "constructor") is ignored in favor of inference rather than indexing into an
  // `undefined` group and throwing — trace() must never break the caller it
  // wraps. A resolved "unknown" means no recognized hook is present, so there is
  // nothing to attach and the run reports `trace.attach_failed` below.
  const override = options.kind;
  const kind: TraceKind =
    override !== undefined && KNOWN_INSTANCE_KINDS.has(override)
      ? override
      : resolveKind(target);
  const role = ROLE_BY_KIND[kind];
  const methods: readonly (keyof HookContextMap)[] =
    kind === "unknown" ? [] : HOOKS_BY_KIND[kind];

  const attached: string[] = [];

  // Generic over the hook name, so each handler's `context` is typed off
  // HookContextMap. The recorded `TraceLogLine.context` stays `unknown`, so no
  // SDK type leaks into the published `.d.ts`. `role` is fixed for this instance.
  const makeLogger =
    <K extends keyof HookContextMap>(hook: K) =>
    (context: HookContextMap[K]): undefined => {
      safeLog({ hook, role, context });
      return undefined;
    };

  for (const name of methods) {
    const register = target[name];
    if (typeof register === "function") {
      try {
        // The typed handler is registered through an `unknown`-context slot;
        // widening the parameter is safe because the SDK only ever calls it with
        // that hook's real context.
        const handler = makeLogger(name) as (context: unknown) => undefined;
        // x402 hooks are chainable and support multiple registrations, so
        // adding our logger runs alongside — never displaces — the user's hooks.
        (
          register as (handler: (context: unknown) => undefined) => unknown
        ).call(target, handler);
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
    role,
    context: { attached, kind },
  });

  const result: TraceAttestation = {
    attached,
    ok: attached.length > 0,
    kind,
    role,
  };
  traced.set(target, result);
  return result;
}
