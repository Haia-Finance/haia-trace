/**
 * The replay path, end to end: the webhook fixtures shipped with
 * `@usehaia/trace-circle` are signed (with a test key), pushed through the real
 * webhook handler, round-tripped through the NDJSON sink codec, and assembled
 * with the shipped `escrow-arc` template. This is the whole webhook capture
 * pipe — capture → normalize → sink → assemble — with no network and no live
 * stand, which is exactly how the adapter is developed and regression-tested.
 *
 * The at-least-once/unordered delivery semantics are asserted at the RECEIPT
 * level here (a retry or a shuffled arrival order must not change the
 * verdict); the event-level behaviors live in the adapter's own tests.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createVerifier,
  createWebhookHandler,
  KEY_ID_HEADER,
  SIGNATURE_HEADER,
  type WebhookHandler,
} from "@usehaia/trace-circle";
import {
  assembleReceipts,
  decodeEventLines,
  encodeEventLine,
  type Receipt,
  type TraceEvent,
} from "@usehaia/trace-core";
import { beforeAll, describe, expect, it } from "vitest";

import { loadTemplate } from "./index.js";

/** The webhook fixtures live in the adapter's package, one body per file. */
const WEBHOOK_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "circle",
  "fixtures",
);

/** The escrow contract the fixtures revolve around — the operation's id. */
const CONTRACT = "0x92b7e5c1d4f3a2b1c0d9e8f7a6b5c4d3e2f10987";

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

type SigningKey = Parameters<typeof crypto.subtle.sign>[1];
let privateKey: SigningKey;
let publicKeyBase64: string;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  privateKey = pair.privateKey;
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  publicKeyBase64 = Buffer.from(spki).toString("base64");
});

function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const encodeInteger = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let value = Array.from(bytes.subarray(start));
    if ((value[0] ?? 0) & 0x80) value = [0, ...value];
    return [0x02, value.length, ...value];
  };
  const body = [
    ...encodeInteger(raw.subarray(0, 32)),
    ...encodeInteger(raw.subarray(32)),
  ];
  return new Uint8Array([0x30, body.length, ...body]);
}

/** A fixture body signed the way Circle delivers it. */
async function signedDelivery(
  body: string,
): Promise<{ body: string; headers: Record<string, string> }> {
  const raw = new Uint8Array(
    await crypto.subtle.sign(SIGN, privateKey, new TextEncoder().encode(body)),
  );
  return {
    body,
    headers: {
      [SIGNATURE_HEADER]: Buffer.from(rawSignatureToDer(raw)).toString(
        "base64",
      ),
      [KEY_ID_HEADER]: "key-1",
    },
  };
}

/** A fresh handler writing into an in-memory NDJSON document. */
function makeReplayRig(): { handler: WebhookHandler; lines: string[] } {
  const lines: string[] = [];
  let id = 0;
  const handler = createWebhookHandler({
    verifier: createVerifier({
      resolveKey: async (keyId) => (keyId === "key-1" ? publicKeyBase64 : null),
    }),
    write: (event) => lines.push(encodeEventLine(event)),
    // Deterministic ids; the clock is irrelevant — every fixture carries its
    // fact time, and the attestation's time does not affect any receipt.
    newId: () => `evt-${id++}`,
    now: () => "2026-07-29T09:00:00.000Z",
  });
  return { handler, lines };
}

/**
 * The deliveries of ONE escrow arc, named rather than globbed: the fixture
 * directory also holds captures from other contracts, and folding those in
 * would assemble several operations where this suite is about one.
 */
const ARC_FIXTURES = [
  "contracts-eventlog-payment-created.json",
  "transactions-inbound-complete.json",
  "transactions-outbound-failed.json",
];

function fixtureBodies(): { name: string; body: string }[] {
  return [...ARC_FIXTURES].sort().map((name) => ({
    name,
    body: readFileSync(join(WEBHOOK_FIXTURES_DIR, name), "utf8"),
  }));
}

/** Replay deliveries through a fresh rig and assemble the run. */
async function replay(
  bodies: string[],
  duplicates: string[] = [],
): Promise<{ receipts: Receipt[]; unassigned: TraceEvent[] }> {
  const { handler, lines } = makeReplayRig();
  for (const body of bodies) {
    const { headers } = await signedDelivery(body);
    const result = await handler.handle(body, headers);
    expect(result.status).toBe(200);
  }
  for (const body of duplicates) {
    const { headers } = await signedDelivery(body);
    const result = await handler.handle(body, headers);
    expect(result).toMatchObject({ status: 200, outcome: "duplicate" });
  }
  // Round-trip through the sink codec — the same read path a real run takes.
  const events = decodeEventLines(`${lines.join("\n")}\n`);
  const template = loadTemplate("escrow-arc");
  return assembleReceipts(events, template);
}

/** The verdict-relevant projection of a receipt — stable across seq/id noise. */
function verdict(receipt: Receipt) {
  return {
    operation_id: receipt.operation.operation_id,
    completeness: receipt.completeness,
    stages: receipt.stages.map((s) => [s.id, s.state]),
    missing: receipt.missing.map((m) => m.stage),
    exceptions: receipt.exceptions.map((e) => e.event_type),
    event_types: receipt.events.map((e) => e.event_type).sort(),
  };
}

describe("replay: webhook fixtures → handler → NDJSON → escrow-arc receipt", () => {
  it("assembles the three deliveries into one money-half PARTIAL receipt", async () => {
    const { receipts, unassigned } = await replay(
      fixtureBodies().map((f) => f.body),
    );

    // One contract = one operation; the attestation is session-level.
    expect(receipts).toHaveLength(1);
    expect(unassigned.map((e) => e.event_type)).toEqual(["trace.attached"]);

    const receipt = receipts[0] as Receipt;
    expect(receipt.operation.operation_id).toBe(CONTRACT);

    // Money half closed by Circle's witnesses...
    const state = Object.fromEntries(
      receipt.stages.map((s) => [s.id, s.state]),
    );
    expect(state.deposit).toBe("confirmed"); // PaymentCreated
    expect(state.disposition).toBe("confirmed"); // inbound arrival from the contract
    // ...obligation half honestly open: webhooks cannot witness it. delivery
    // and criteria are optional stages (a refund path never reaches them), so
    // they stay not_confirmed without appearing in `missing` — the required
    // gap that keeps this receipt partial is the agreement itself, which only
    // the escrow backend can attest and no webhook replay contains.
    expect(state.delivery).toBe("not_confirmed");
    expect(state.criteria).toBe("not_confirmed");
    expect(receipt.completeness).toBe("partial");
    expect(receipt.missing.map((m) => m.stage)).toEqual(["agreement"]);

    // The failed funding attempt surfaces as a fault, not as progress.
    expect(receipt.exceptions.map((e) => e.event_type)).toEqual([
      "circle.transaction.outbound.failed",
    ]);
  });

  it("yields the same verdict when Circle retries a delivery", async () => {
    const bodies = fixtureBodies().map((f) => f.body);
    const clean = await replay(bodies);
    const withRetries = await replay(bodies, [
      bodies[0] as string,
      bodies[2] as string,
    ]);

    expect(withRetries.receipts.map(verdict)).toEqual(
      clean.receipts.map(verdict),
    );
  });

  it("yields the same verdict regardless of arrival order", async () => {
    const bodies = fixtureBodies().map((f) => f.body);
    const forward = await replay(bodies);
    const reversed = await replay([...bodies].reverse());

    expect(reversed.receipts.map(verdict)).toEqual(
      forward.receipts.map(verdict),
    );
  });
});
