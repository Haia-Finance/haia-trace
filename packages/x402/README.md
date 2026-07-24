# @usehaia/trace-x402

The [Haia Trace](https://github.com/Haia-Finance/haia-trace) capture adapter for
the [x402](https://docs.x402.org) payment SDK. Attach it to an x402 instance and
it records every lifecycle-hook firing — **strictly passively**, so it can
observe a payment but never alter it.

Zero runtime dependencies beyond `@usehaia/trace-core`.

## Install

```sh
npm install @usehaia/trace-x402
```

## Connect it

Call `trace()` once, passing your x402 instance — a client, resource server,
facilitator, or MCP client:

```ts
import { trace } from "@usehaia/trace-x402";
import { x402HTTPClient } from "@x402/core/client";

const client = x402HTTPClient({ /* ... */ });

// Attach the recorder. One line, and it's idempotent per instance.
trace(client);
```

`trace()` inspects the instance's method set to resolve its **kind**, attaches to
that kind's lifecycle hooks, and logs the context each hook is handed, tagging
every line with the observing **role** (`client` / `server` / `facilitator`).

It works the same on either side of a payment:

```ts
import { x402HTTPResourceServer } from "@x402/core/server";

const server = x402HTTPResourceServer({ /* ... */ });
trace(server); // role: "server"
```

Detection is pure duck-typing — no `@x402` value is imported at runtime — so
API-compatible forks are covered too. If a shape can't be placed, you can force
the kind (see below).

## Passivity — the load-bearing guarantee

x402 lifecycle hooks can steer the payment flow through their return value
(`{ abort }`, `{ skip }`, `{ recovered }`, …). Every handler this adapter
registers is wrapped in `try`/`catch` and **always returns `undefined`**, and
hooks are chainable, so the recorder runs *alongside* your own hooks and never
displaces or overrides them. The worst case of a recorder bug is "capture
stopped", never "payment blocked".

Set `HAIA_TRACE_DISABLE=1` in the environment to make `trace()` a no-op.

## Options

```ts
trace(instance, {
  // Where each hook firing goes. Default: console.log.
  log: (line) => myLogger.info(line),

  // Observe recorder-internal errors (e.g. a throwing `log`). Never reaches the
  // payment path.
  onError: (err) => myLogger.warn(err),

  // Force the instance kind instead of inferring it. Use when a fork's shape is
  // ambiguous — e.g. a resource server that doesn't expose the hook Trace keys on.
  kind: "resourceServer",
});
```

Each logged line has the shape `{ hook, role, context }`.

## Attestation

`trace()` returns a `TraceAttestation` describing what it connected to — so a
caller can tell "no payment events happened" apart from "the recorder never wired
up":

```ts
const att = trace(client);
// { attached: string[], ok: boolean, kind: TraceKind, role: TraceRole }
if (!att.ok) console.warn("trace-x402 did not attach to this instance");
```

The adapter also emits a `trace.attached` / `trace.attach_failed` line on every
run for the same reason.

## Recognized kinds

| Kind                 | Role          | x402 instance                 |
| -------------------- | ------------- | ----------------------------- |
| `client`             | `client`      | x402Client                    |
| `httpClient`         | `client`      | x402HTTPClient                |
| `mcpClient`          | `client`      | x402MCPClient                 |
| `resourceServer`     | `server`      | x402ResourceServer            |
| `httpResourceServer` | `server`      | x402HTTPResourceServer        |
| `facilitator`        | `facilitator` | x402Facilitator               |
| `unknown`            | `unknown`     | unrecognized shape — nothing attached |

## Status

This adapter currently records hook firings as **raw context**. Two pieces are
still on the roadmap, and until they land it is meant for local development and
wiring, **not a production or real-money flow**:

- **Normalized events + local sink.** Mapping firings to the Event Contract's
  `event_type`s (`x402.payment.required`, …) and writing them to
  `.trace/events/*.ndjson`, so `trace(...)` feeds
  [`haia-trace build`](https://github.com/Haia-Finance/haia-trace/tree/main/packages/cli)
  and produces a Receipt end-to-end.
- **Redaction.** The raw context can contain signatures and credentials; an
  allowlist-based redaction pass is not in place yet.

## License

[MIT](https://github.com/Haia-Finance/haia-trace/blob/main/LICENSE)
