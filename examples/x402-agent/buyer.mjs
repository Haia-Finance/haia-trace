/**
 * A buyer agent that pays for two API calls over x402, traced.
 *
 * Only the agent is instrumented. The sellers are other people's services — the
 * agent has no access to their code, their logs or their hooks, which is the
 * normal case: you own your side of a payment and nothing else.
 *
 * Both calls settle. The first returns the data that was paid for; the second
 * returns nothing usable. Run `haia-trace build` afterwards and the two
 * operations assemble into a `full` receipt and a `partial` one — from the
 * buyer's own observations alone.
 *
 * What is real here: the x402 client (`@x402/core`), its hook registries, the
 * recorder attached to it, the Event Contract on disk, and the assembler that
 * reads it. What is simulated: the money and the seller. There is no chain, no
 * facilitator and no wallet, so the lifecycle is driven locally by invoking the
 * hooks the SDK would invoke. This example fakes the payment, never the trace.
 */

import { createRecorder } from "@usehaia/trace-core";
import { createFileReader, createRunWriter } from "@usehaia/trace-core/node";
import { trace } from "@usehaia/trace-x402";
import { x402Client, x402HTTPClient } from "@x402/core/client";

// The agent's x402 client — the only thing this process owns.
const client = new x402Client();
const agent = new x402HTTPClient(client);

// ─── Haia Trace: the entire integration ──────────────────────────────────────

// No path to agree on: the writer defaults to the run directory
// `haia-trace build` reads from.
const writer = createRunWriter();

const capture = trace(agent, { writer });

/** The agent's own record of having received what it paid for. */
const app = createRecorder({ adapter: "buyer-app" });

/**
 * The operation the recorder grouped the payment it just saw under. A real app
 * takes this from its own call context; reading back the run keeps the example
 * to the public API.
 */
const currentOperation = () =>
  createFileReader(writer.path).read().at(-1)?.context_id;

// ─────────────────────────────────────────────────────────────────────────────

// The attestation says what capture actually connected to — so "no events" can
// never be confused with "the recorder never attached".
console.log(
  `capture: ${capture.kind}  ${capture.attached.length} hooks  complete=${capture.complete}`,
);

/** Fire one of the client's hook registries, the way the SDK does. */
function fire(owner, registry, context) {
  for (const hook of owner[registry] ?? []) hook(context);
}

/**
 * One paid call: the seller's 402, the payment, the seller's settled response,
 * and whether anything useful came back.
 *
 * `delivered: false` is the interesting path. Nothing about the payment failed —
 * the seller even returns a transaction hash — and the agent still has nothing.
 */
function paidCall({ url, nonce, transaction, delivered }) {
  const requirements = {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: "10000",
    payTo: "0xSELLER",
    maxTimeoutSeconds: 60,
  };

  // The seller's 402 challenge. The client threads this same object through
  // payment creation, which is how those firings group into one operation.
  const paymentRequired = {
    x402Version: 2,
    resource: { url, description: "Market data", mimeType: "application/json" },
    accepts: [requirements],
  };

  // The authorization the agent signs. The signature is deliberately present:
  // the recorder must never let it reach an event.
  const paymentPayload = {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: requirements,
    payload: {
      authorization: { nonce, from: "0xBUYER", to: "0xSELLER", value: "10000" },
      signature: "0xSIGNATURE-THAT-MUST-NEVER-BE-RECORDED",
    },
  };

  // 1. The seller demands payment; the agent signs and submits.
  fire(agent, "paymentRequiredHooks", { paymentRequired });
  fire(client, "beforePaymentCreationHooks", {
    paymentRequired,
    selectedRequirements: requirements,
  });
  fire(client, "afterPaymentCreationHooks", { paymentRequired, paymentPayload });

  // 2. The seller reports the payment settled, with a transaction to prove it.
  //    This is the seller's own claim — the strongest evidence the agent has,
  //    and it says nothing about whether the paid work happened.
  fire(client, "paymentResponseHooks", {
    paymentPayload,
    requirements,
    settleResponse: {
      success: true,
      transaction,
      network: requirements.network,
      payer: "0xBUYER",
    },
  });

  // 3. The agent checks what actually came back. x402 ends at settlement, so
  //    this milestone can only come from the agent itself — and when the data
  //    never arrives, the receipt says so instead of assuming success.
  if (!delivered) return;

  writer.write(
    app.event({
      event_type: "http.response.delivered",
      context_id: currentOperation(),
      role: "client",
      payload: { status: 200, url, bytes: 8123 },
    }),
  );
}

console.log("\nagent: buying market data from two APIs\n");

paidCall({
  url: "https://api.example.com/v1/quote",
  nonce: "0x01",
  transaction: "0xf1e2d3c4b5a60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  delivered: true,
});
console.log("  /v1/quote    paid · data received");

paidCall({
  url: "https://api.other-vendor.com/v1/report",
  nonce: "0x02",
  transaction: "0xa9b8c7d6e5f40312233445566778899aabbccddeeff00112233445566778899a",
  delivered: false,
});
console.log("  /v1/report   paid · nothing came back");

writer.close();
console.log(`\nrun recorded → ${writer.path}`);
console.log("next: haia-trace build\n");
