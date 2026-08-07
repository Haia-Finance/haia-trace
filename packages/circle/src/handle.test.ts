/**
 * Pipeline tests run the REAL pieces end to end — a live verifier over a
 * self-generated P-256 key, the real envelope parser, the real dedupe store —
 * with only the boundary I/O (key resolution, persistence) injected. What is
 * asserted is the handler's decision contract: which requests are 200/400/500,
 * what reaches the sink, and that a failed write never turns a retry into a
 * silently-dropped duplicate.
 */

import type { TraceEvent } from "@usehaia/trace-core";
import { beforeAll, describe, expect, it } from "vitest";

import {
  ADAPTER_ID,
  createWebhookHandler,
  KEY_ID_HEADER,
  type NormalizeNotification,
  SIGNATURE_HEADER,
  type WebhookHandlerOptions,
} from "./handle.js";
import { createVerifier, type PublicKeyResolver } from "./verify.js";

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

const KEY_ID = "key-1";
const resolver: PublicKeyResolver = async (keyId) =>
  keyId === KEY_ID ? publicKeyBase64 : null;

/** A signed request as Circle would deliver it: body string + both headers. */
async function signedRequest(
  envelope: Record<string, unknown>,
): Promise<{ body: string; headers: Record<string, string> }> {
  const body = JSON.stringify(envelope);
  const raw = new Uint8Array(
    await crypto.subtle.sign(SIGN, privateKey, new TextEncoder().encode(body)),
  );
  return {
    body,
    headers: {
      [SIGNATURE_HEADER]: Buffer.from(rawSignatureToDer(raw)).toString(
        "base64",
      ),
      [KEY_ID_HEADER]: KEY_ID,
    },
  };
}

function envelopeFor(notificationId: string): Record<string, unknown> {
  return {
    subscriptionId: "8e29afe0-6d3d-4c47-a11d-8d1d24d8b1a3",
    notificationId,
    notificationType: "transactions.inbound",
    notification: {
      id: "1af639ce-c8b2-54a6-af49-7aebc95aaac1",
      state: "COMPLETE",
      txHash: "0xf7cc8d6b",
    },
    timestamp: "2026-07-28T12:00:00.000Z",
    version: 2,
  };
}

/** The trivial mapping used by most tests: one event per notification. */
const normalizeOne: NormalizeNotification = (envelope) => [
  {
    event_type: `test.${envelope.notification_type}`,
    payload: { notification_id: envelope.notification_id },
  },
];

function makeHandler(overrides: Partial<WebhookHandlerOptions> = {}) {
  const written: TraceEvent[] = [];
  const handler = createWebhookHandler({
    verifier: createVerifier({ resolveKey: resolver }),
    normalize: normalizeOne,
    write: (event) => {
      written.push(event);
    },
    ...overrides,
  });
  return { handler, written };
}

describe("createWebhookHandler", () => {
  it("records a valid delivery: 200, attestation + event stamped with the adapter id", async () => {
    const { handler, written } = makeHandler();
    const { body, headers } = await signedRequest(envelopeFor("n-1"));

    const result = await handler.handle(body, headers);
    expect(result).toMatchObject({ status: 200, outcome: "recorded" });
    // The first verified delivery carries the session attestation ahead of it.
    expect(written.map((event) => event.event_type)).toEqual([
      "trace.attached",
      "test.transactions.inbound",
    ]);
    expect(written[0]?.adapter).toBe(ADAPTER_ID);
    // The attestation belongs to the session, not to any operation.
    expect("context_id" in (written[0] ?? {})).toBe(false);
    if (result.outcome === "recorded") {
      expect(result.events).toEqual(written);
      expect(result.envelope.notification_id).toBe("n-1");
    }
  });

  it("attests once per session — later deliveries record only their events", async () => {
    const { handler, written } = makeHandler();
    const first = await signedRequest(envelopeFor("n-1"));
    const second = await signedRequest(envelopeFor("n-2"));

    await handler.handle(first.body, first.headers);
    await handler.handle(second.body, second.headers);
    expect(
      written.filter((event) => event.event_type === "trace.attached"),
    ).toHaveLength(1);
  });

  it("acknowledges a retry as a duplicate without writing again", async () => {
    const { handler, written } = makeHandler();
    const request = await signedRequest(envelopeFor("n-1"));

    await handler.handle(request.body, request.headers);
    const before = written.length;
    const retry = await handler.handle(request.body, request.headers);
    expect(retry).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(written).toHaveLength(before);
  });

  it("rejects a missing header with 400 before touching anything", async () => {
    const { handler, written } = makeHandler();
    const { body, headers } = await signedRequest(envelopeFor("n-1"));
    delete (headers as Record<string, string>)[KEY_ID_HEADER];

    const result = await handler.handle(body, headers);
    expect(result).toMatchObject({ status: 400, outcome: "missing_signature" });
    expect(written).toHaveLength(0);
  });

  it("rejects a tampered body with 400 invalid_signature", async () => {
    const { handler, written } = makeHandler();
    const { body, headers } = await signedRequest(envelopeFor("n-1"));

    const result = await handler.handle(
      body.replace("COMPLETE", "COMPLETX"),
      headers,
    );
    expect(result).toMatchObject({ status: 400, outcome: "invalid_signature" });
    expect(written).toHaveLength(0);
  });

  it("rejects a correctly-signed but malformed envelope with 400", async () => {
    const { handler, written } = makeHandler();
    // Signed by our key, so verification passes — the envelope is still junk.
    const { body, headers } = await signedRequest({ version: 1, junk: true });

    const result = await handler.handle(body, headers);
    expect(result).toMatchObject({ status: 400, outcome: "invalid_envelope" });
    expect(written).toHaveLength(0);
  });

  it("answers 500 when key resolution fails, inviting a retry", async () => {
    const { handler } = makeHandler({
      verifier: createVerifier({
        resolveKey: async () => {
          throw new Error("publicKey endpoint unreachable");
        },
      }),
    });
    const { body, headers } = await signedRequest(envelopeFor("n-1"));

    const result = await handler.handle(body, headers);
    expect(result).toMatchObject({
      status: 500,
      outcome: "key_resolution_failed",
    });
  });

  it("answers 500 on a write failure and lets the retry record — never a dropped duplicate", async () => {
    let failNext = true;
    const written: TraceEvent[] = [];
    const { handler } = makeHandler({
      write: (event) => {
        if (failNext) throw new Error("disk full");
        written.push(event);
      },
    });
    const request = await signedRequest(envelopeFor("n-1"));

    const failed = await handler.handle(request.body, request.headers);
    expect(failed).toMatchObject({ status: 500, outcome: "record_failed" });
    expect(written).toHaveLength(0);

    failNext = false;
    const retry = await handler.handle(request.body, request.headers);
    expect(retry).toMatchObject({ status: 200, outcome: "recorded" });
    // Attestation + the delivery's event: the failed write attested nothing.
    expect(written.map((event) => event.event_type)).toEqual([
      "trace.attached",
      "test.transactions.inbound",
    ]);
  });

  it("answers 500 when the sink refuses by returning false — the boolean dialect of the same failure", async () => {
    // A sink-contract writer never throws; a refused event comes back as
    // `false`. That must be indistinguishable from a thrown failure: 500, no
    // dedupe claim left behind, and the retry records in full.
    let refuse = true;
    const written: TraceEvent[] = [];
    const { handler } = makeHandler({
      write: (event) => {
        if (refuse) return false;
        written.push(event);
        return true;
      },
    });
    const request = await signedRequest(envelopeFor("n-1"));

    const failed = await handler.handle(request.body, request.headers);
    expect(failed).toMatchObject({ status: 500, outcome: "record_failed" });
    expect(written).toHaveLength(0);

    refuse = false;
    const retry = await handler.handle(request.body, request.headers);
    expect(retry).toMatchObject({ status: 200, outcome: "recorded" });
    expect(written.map((event) => event.event_type)).toEqual([
      "trace.attached",
      "test.transactions.inbound",
    ]);
  });

  it("acknowledges a type normalize maps to nothing — only the attestation is written", async () => {
    const { handler, written } = makeHandler({ normalize: () => [] });
    const { body, headers } = await signedRequest(envelopeFor("n-1"));

    const result = await handler.handle(body, headers);
    expect(result).toMatchObject({ status: 200, outcome: "recorded" });
    expect(written.map((event) => event.event_type)).toEqual([
      "trace.attached",
    ]);
    if (result.outcome === "recorded") expect(result.events).toEqual(written);
  });

  it("defaults normalize to the package vocabulary when not supplied", async () => {
    const written: TraceEvent[] = [];
    const handler = createWebhookHandler({
      verifier: createVerifier({ resolveKey: resolver }),
      write: (event) => {
        written.push(event);
      },
    });
    const { body, headers } = await signedRequest(envelopeFor("n-1"));

    const result = await handler.handle(body, headers);
    expect(result).toMatchObject({ status: 200, outcome: "recorded" });
    // envelopeFor is transactions.inbound with state COMPLETE.
    expect(written.map((event) => event.event_type)).toEqual([
      "trace.attached",
      "circle.transaction.inbound.complete",
    ]);
  });

  it("reads headers case-insensitively and from Headers-like objects", async () => {
    const { handler } = makeHandler();
    const { body, headers } = await signedRequest(envelopeFor("n-1"));

    const upper = {
      "X-Circle-Signature": headers[SIGNATURE_HEADER] as string,
      "X-Circle-Key-Id": headers[KEY_ID_HEADER] as string,
    };
    expect((await handler.handle(body, upper)).status).toBe(200);

    // Retry via a fetch-style Headers object — same id, so a duplicate.
    const map = new Map(Object.entries(headers));
    const headersLike = { get: (name: string) => map.get(name) ?? null };
    const result = await handler.handle(body, headersLike);
    expect(result).toMatchObject({ status: 200, outcome: "duplicate" });
  });

  it("stamps monotonic seq across deliveries — one handler is one session", async () => {
    const { handler, written } = makeHandler();
    const first = await signedRequest(envelopeFor("n-1"));
    const second = await signedRequest(envelopeFor("n-2"));

    await handler.handle(first.body, first.headers);
    await handler.handle(second.body, second.headers);
    // seq 0 is the session attestation; deliveries continue from there.
    expect(written.map((event) => event.seq)).toEqual([0, 1, 2]);
  });
});
