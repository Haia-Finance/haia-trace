/**
 * The x402 hook surface: which lifecycle hooks each instance kind exposes, the
 * context each hook is handed, and how an untyped instance is placed into a kind.
 *
 * Hooks reference: https://docs.x402.org/advanced-concepts/lifecycle-hooks
 *
 * Detection is pure duck-typing — no `@x402` value is imported at runtime — so
 * API-compatible forks are covered and an unrecognized shape degrades to
 * `"unknown"` rather than failing.
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
export type HookName =
  | keyof HttpClientHooks
  | keyof HttpResourceServerHooks
  | keyof FacilitatorHooks
  | keyof McpClientHooks;
export type HookContextMap = {
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
export type TraceInstanceKind = Exclude<TraceKind, "unknown">;
/** The observing side of a payment, stamped on every recorded event. */
export type TraceRole = "client" | "server" | "facilitator" | "unknown";

/** Every kind's role. A kind fixes the role for all of that instance's hooks. */
export const ROLE_BY_KIND: Record<TraceKind, TraceRole> = {
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
export const HOOKS_BY_KIND: Record<
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
export const KNOWN_INSTANCE_KINDS = new Set<string>(Object.keys(HOOKS_BY_KIND));

/**
 * Where a kind keeps the instance that owns the rest of its hooks.
 *
 * The two HTTP types are wrappers: `x402HTTPClient` exposes only
 * `onPaymentRequired` and `x402HTTPResourceServer` only `onProtectedRequest`,
 * while the payment-creation and verify/settle hooks live on the `x402Client` /
 * `x402ResourceServer` each holds. Attaching to the wrapper alone would register
 * one hook out of the kind's group and still look like a connected recorder.
 *
 * Each candidate property is checked for the inner kind's hooks before it is
 * used, so this stays duck-typing: a wrapper that renames the field, or a
 * monolithic fork that owns every hook itself, simply matches nothing here.
 */
export const INNER_BY_KIND: Partial<
  Record<
    TraceInstanceKind,
    { props: readonly string[]; kind: TraceInstanceKind }
  >
> = {
  // `server` is the documented getter; the private field it reads is the fallback.
  httpResourceServer: {
    props: ["server", "ResourceServer"],
    kind: "resourceServer",
  },
  httpClient: { props: ["client"], kind: "client" },
};

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
export function resolveKind(target: Record<string, unknown>): TraceKind {
  const has = (method: string): boolean => typeof target[method] === "function";
  if (has("onBeforePayment") || has("onAfterPayment")) return "mcpClient";
  if (has("onProtectedRequest")) return "httpResourceServer";
  if (has("onVerifiedPaymentCanceled")) return "resourceServer";
  if (FACILITATOR_METHODS.some(has)) return "facilitator";
  if (has("onPaymentRequired")) return "httpClient";
  if (CLIENT_METHODS.some(has)) return "client";
  return "unknown";
}
