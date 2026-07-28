/**
 * Signature tests run on a self-generated P-256 key pair: Circle's real
 * signatures cannot be reproduced without Circle's private key, so signing our
 * own fixtures IS the honest way to exercise the verify path. Web Crypto signs
 * in raw `r || s` form while Circle ships ASN.1 DER, so the tests wrap raw
 * signatures into DER — exercising the same unwrap production input takes.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

import { createVerifier, type PublicKeyResolver } from "./verify.js";

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

// The key type exactly as `subtle.sign` expects it — derived rather than named,
// since the tsconfig's ES2022 lib does not declare the `CryptoKey` global.
type SigningKey = Parameters<typeof crypto.subtle.sign>[1];

let privateKey: SigningKey;
let publicKeyBase64: string;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  privateKey = pair.privateKey;
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  publicKeyBase64 = Buffer.from(spki).toString("base64");
});

/** Wrap a raw 64-byte `r || s` signature into ASN.1 DER, the form Circle sends. */
function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const encodeInteger = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let value = Array.from(bytes.subarray(start));
    // A leading high bit would read as negative; DER prepends a zero byte.
    if ((value[0] ?? 0) & 0x80) value = [0, ...value];
    return [0x02, value.length, ...value];
  };
  const body = [
    ...encodeInteger(raw.subarray(0, 32)),
    ...encodeInteger(raw.subarray(32)),
  ];
  return new Uint8Array([0x30, body.length, ...body]);
}

/** Sign a body the way Circle does: ECDSA/SHA-256, base64-encoded DER. */
async function signLikeCircle(body: string | Uint8Array): Promise<string> {
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  const raw = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, bytes));
  return Buffer.from(rawSignatureToDer(raw)).toString("base64");
}

const KEY_ID = "key-1";
const resolver: PublicKeyResolver = async (keyId) =>
  keyId === KEY_ID ? publicKeyBase64 : null;

describe("createVerifier", () => {
  const body = '{"notificationId":"n-1","notification":{"state":"COMPLETE"}}';

  it("accepts a valid signature over a string body", async () => {
    const verifier = createVerifier({ resolveKey: resolver });
    const signature = await signLikeCircle(body);
    expect(await verifier.verify(body, signature, KEY_ID)).toBe(true);
  });

  it("accepts a valid signature over a byte body", async () => {
    const verifier = createVerifier({ resolveKey: resolver });
    const bytes = new TextEncoder().encode(body);
    const signature = await signLikeCircle(bytes);
    expect(await verifier.verify(bytes, signature, KEY_ID)).toBe(true);
  });

  it("rejects when even one body byte differs", async () => {
    const verifier = createVerifier({ resolveKey: resolver });
    const signature = await signLikeCircle(body);
    const tampered = body.replace("COMPLETE", "COMPLETX");
    expect(await verifier.verify(tampered, signature, KEY_ID)).toBe(false);
  });

  it("rejects a signature by a different key", async () => {
    const other = await crypto.subtle.generateKey(ALG, true, ["sign"]);
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        SIGN,
        other.privateKey,
        new TextEncoder().encode(body),
      ),
    );
    const signature = Buffer.from(rawSignatureToDer(raw)).toString("base64");
    const verifier = createVerifier({ resolveKey: resolver });
    expect(await verifier.verify(body, signature, KEY_ID)).toBe(false);
  });

  it("rejects an unknown key id (resolver returns null)", async () => {
    const verifier = createVerifier({ resolveKey: resolver });
    const signature = await signLikeCircle(body);
    expect(await verifier.verify(body, signature, "key-unknown")).toBe(false);
  });

  it("rejects malformed signatures without throwing", async () => {
    const verifier = createVerifier({ resolveKey: resolver });
    for (const bad of [
      "",
      "not base64 !!!",
      Buffer.from("junk").toString("base64"),
    ]) {
      expect(await verifier.verify(body, bad, KEY_ID)).toBe(false);
    }
  });

  it("propagates a resolver failure — infrastructure, not an invalid request", async () => {
    const failing: PublicKeyResolver = async () => {
      throw new Error("publicKey endpoint unreachable");
    };
    const verifier = createVerifier({ resolveKey: failing });
    await expect(verifier.verify(body, "AA==", KEY_ID)).rejects.toThrow(
      "unreachable",
    );
  });

  it("throws when the resolver returns a value that is not a key", async () => {
    const verifier = createVerifier({
      resolveKey: async () => "not base64 !!!",
    });
    const signature = await signLikeCircle(body);
    await expect(verifier.verify(body, signature, KEY_ID)).rejects.toThrow(
      "not valid base64",
    );
  });

  it("resolves each key id once — the key is static and cached", async () => {
    const counting = vi.fn(resolver);
    const verifier = createVerifier({ resolveKey: counting });
    const signature = await signLikeCircle(body);
    expect(await verifier.verify(body, signature, KEY_ID)).toBe(true);
    expect(await verifier.verify(body, signature, KEY_ID)).toBe(true);
    expect(counting).toHaveBeenCalledTimes(1);
  });

  it("does not cache an unknown key id, so rotation to it later still works", async () => {
    let known = false;
    const rotating: PublicKeyResolver = async () =>
      known ? publicKeyBase64 : null;
    const verifier = createVerifier({ resolveKey: rotating });
    const signature = await signLikeCircle(body);
    expect(await verifier.verify(body, signature, KEY_ID)).toBe(false);
    known = true;
    expect(await verifier.verify(body, signature, KEY_ID)).toBe(true);
  });
});
