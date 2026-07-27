/**
 * A buyer agent that pays for two API calls over x402, traced.
 *
 * Only the agent is instrumented. The sellers are other people's services — the
 * agent has no access to their code, their logs or their hooks, which is the
 * normal case: you own your side of a payment and nothing else.
 *
 * The first call settles. The second is signed, sent, and never comes back with
 * a settlement — the agent is left holding a payment it cannot account for. Run
 * `haia-trace build` afterwards and the two operations assemble into a `full`
 * receipt and a `partial` one, from the buyer's own observations alone.
 *
 * What is real here: the x402 client (`@x402/core`), its hook registries, the
 * recorder attached to it, the Event Contract on disk, and the assembler that
 * reads it. What is simulated: the money and the sellers. There is no chain, no
 * facilitator and no wallet, so the lifecycle is driven locally by invoking the
 * hooks the SDK would invoke. This example fakes the payment, never the trace.
 */

import { createRunWriter } from "@usehaia/trace-core/node";
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
 * One paid call: the seller's 402, the signed payment, and whatever the seller
 * sent back.
 *
 * `settled: false` is the interesting path. The agent did everything right and
 * the response carries no settlement, so whether the money moved is exactly what
 * nobody can tell it.
 */
function paidCall({ url, nonce, transaction, settled }) {
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
  fire(client, "afterPaymentCreationHooks", {
    paymentRequired,
    paymentPayload,
  });

  // 2. What came back. A settlement — with a transaction to point at — closes
  //    the operation. Anything else leaves it open: the adapter reports the
  //    outcome it observed and never upgrades a silence into a settlement.
  fire(client, "paymentResponseHooks", {
    paymentPayload,
    requirements,
    settleResponse: settled
      ? {
          success: true,
          transaction,
          network: requirements.network,
          payer: "0xBUYER",
        }
      : undefined,
    error: settled ? undefined : new Error("upstream timed out after 30s"),
  });
}

console.log("\nagent: buying market data from two APIs\n");

paidCall({
  url: "https://api.example.com/v1/quote",
  nonce: "0x01",
  transaction:
    "0xf1e2d3c4b5a60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  settled: true,
});
console.log("  /v1/quote    paid · settled");

paidCall({
  url: "https://api.other-vendor.com/v1/report",
  nonce: "0x02",
  settled: false,
});
console.log("  /v1/report   paid · no settlement came back");

writer.close();
console.log(`\nrun recorded → ${writer.path}`);
console.log("next: haia-trace build\n");
