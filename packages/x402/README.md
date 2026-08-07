# @usehaia/trace-x402

The [Haia Trace](https://github.com/Haia-Finance/haia-trace) capture adapter for
the [x402](https://docs.x402.org) payment SDK. Attach it to an x402 instance and
every [lifecycle-hook](https://docs.x402.org/advanced-concepts/lifecycle-hooks)
firing becomes a normalized, redacted Trace event. Capture is strictly passive:
it observes a payment, never steers one.

Works on every side — client, resource server, facilitator, MCP — and stamps each
event with the role that observed it.

ESM only, Node ≥ 22, no runtime dependencies beyond `@usehaia/trace-core`.

📖 **[developers.haia.finance/sdk/x402](https://developers.haia.finance/sdk/x402)**
— every event it records, redaction, options.

## Install

```sh
npm install @usehaia/trace-x402
```

## Attach it

One call, anywhere after you construct the instance:

```ts
import { createRunEventWriter } from "@usehaia/trace-core/file";
import { trace } from "@usehaia/trace-x402";
import { x402Client, x402HTTPClient } from "@x402/core/client";

const agent = new x402HTTPClient(new x402Client());

trace(agent, { writer: createRunEventWriter(".trace/events") });
```

That is the whole integration. `trace()` is idempotent per instance, resolves the
instance's kind by duck-typing its method set, and with no `writer` prints NDJSON
to stdout. The same call works on the other side:

```ts
import { x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";

trace(new x402HTTPResourceServer(new x402ResourceServer(), routes));
```

## Then build a receipt

`.trace/events` is where [`@usehaia/trace-cli`](https://www.npmjs.com/package/@usehaia/trace-cli)
reads from — naming the same directory on both sides is what makes recording and
assembly meet:

```sh
haia-trace build                            # a client capture (x402-buyer)
haia-trace build --template x402-seller     # a resource server
haia-trace build --template x402-facilitator
```

Apply the template matching the side you traced — one build per side, even when a
single run captured two.

## Redaction

Payloads are built from an allowlist, never copied from the hook context. The
signed authorization that moves the money (`PaymentPayload.payload`) and the
open-ended `extra` / `extensions` bags are never written.

## License

[MIT](https://github.com/Haia-Finance/haia-trace/blob/main/LICENSE)
