/**
 * Signature verification for Circle webhook v2 notifications.
 * Reference: https://developers.circle.com/api-reference/verify-webhook-signatures
 *
 * Every v2 notification is signed with ECDSA (P-256, SHA-256) over the RAW
 * request body. Circle sends two headers:
 * - `X-Circle-Signature` — the signature, base64-encoded ASN.1 DER;
 * - `X-Circle-Key-Id` — id of the public key, fetched once from
 *   `GET /v2/notifications/publicKey/{keyId}` (base64 SPKI, static per key id).
 *
 * Verification MUST run against the body bytes exactly as received. Re-parsing
 * and re-serializing the JSON can change the bytes (key order, whitespace,
 * unicode escapes) and turn a valid signature into a mismatch — which is why
 * `verify` takes the raw body, never a parsed object.
 *
 * Implemented on Web Crypto (`globalThis.crypto.subtle`) — a global in
 * Node >= 20, browsers, and edge runtimes — so the package stays
 * runtime-agnostic and dependency-free. Web Crypto expects ECDSA signatures in
 * raw `r || s` (IEEE P1363) form while Circle sends ASN.1 DER, so the DER
 * envelope is unwrapped here before verifying.
 *
 * Error philosophy: a malformed signature, key id, or body is an *invalid
 * signature* (`false`) — the request is not from Circle and a retry cannot fix
 * it. A failing key resolver (network, credentials) is an *infrastructure
 * error* and is thrown — the caller should surface it so Circle retries later.
 */

/**
 * Fetch the base64-encoded SPKI public key for a key id — the exact string the
 * Circle publicKey endpoint returns in `data.publicKey`.
 *
 * Injected rather than built in: the endpoint requires the caller's Circle API
 * credentials, which must never live inside this package. Return `null` for an
 * unknown key id (the notification then simply fails verification); throw only
 * on infrastructure failure. Results are cached per key id by the verifier, so
 * a resolver does not need its own cache.
 */
export type PublicKeyResolver = (keyId: string) => Promise<string | null>;

export interface VerifierOptions {
  /** Where public keys come from; see `PublicKeyResolver`. */
  resolveKey: PublicKeyResolver;
}

export interface NotificationVerifier {
  /**
   * Whether `signature` (base64 DER, from `X-Circle-Signature`) is a valid
   * signature of `rawBody` by the key `keyId` (from `X-Circle-Key-Id`).
   * Returns false for any malformed input; throws only if the key resolver does.
   */
  verify(
    rawBody: string | Uint8Array,
    signature: string,
    keyId: string,
  ): Promise<boolean>;
}

// Web Crypto, read off `globalThis` with local minimal types so this module
// needs neither `lib: ["DOM"]` nor `@types/node` — the same discipline core's
// recorder applies to `crypto.randomUUID`. `CryptoKeyLike` is opaque: the key
// object is only ever handed back to `subtle.verify`.
type CryptoKeyLike = unknown;
interface SubtleLike {
  importKey(
    format: "spki",
    keyData: Uint8Array,
    algorithm: { name: "ECDSA"; namedCurve: "P-256" },
    extractable: boolean,
    keyUsages: readonly ["verify"],
  ): Promise<CryptoKeyLike>;
  verify(
    algorithm: { name: "ECDSA"; hash: "SHA-256" },
    key: CryptoKeyLike,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}
function getSubtle(): SubtleLike {
  return (globalThis as unknown as { crypto: { subtle: SubtleLike } }).crypto
    .subtle;
}

type TextEncoderLike = { encode(input: string): Uint8Array };
function encodeUtf8(text: string): Uint8Array {
  const ctor = (
    globalThis as unknown as { TextEncoder: new () => TextEncoderLike }
  ).TextEncoder;
  return new ctor().encode(text);
}

/** Decode base64 into bytes, or `null` when the input is not base64. `atob` is
 *  a global in Node >= 16, browsers, and edge runtimes. */
function base64ToBytes(base64: string): Uint8Array | null {
  const atobFn = (globalThis as unknown as { atob: (data: string) => string })
    .atob;
  let binary: string;
  try {
    binary = atobFn(base64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Unwrap an ASN.1 DER ECDSA signature — `SEQUENCE { INTEGER r, INTEGER s }` —
 * into the raw 64-byte `r || s` form Web Crypto verifies. Returns `null` on any
 * structural mismatch: a malformed signature is an invalid signature, not an
 * error. Strict about what P-256 can produce: each integer fits 32 bytes after
 * stripping the sign-padding zero DER prepends to values with the high bit set.
 */
function derSignatureToRaw(der: Uint8Array): Uint8Array | null {
  let offset = 0;

  const readLength = (): number | null => {
    const first = der[offset++];
    if (first === undefined) return null;
    // Short form covers lengths up to 127; a P-256 signature body is at most
    // ~70 bytes, so the only long form that can legitimately appear is the
    // one-byte 0x81 wrapper some encoders emit.
    if (first < 0x80) return first;
    if (first === 0x81) {
      const len = der[offset++];
      return len === undefined ? null : len;
    }
    return null;
  };

  if (der[offset++] !== 0x30) return null;
  const seqLen = readLength();
  if (seqLen === null || offset + seqLen !== der.length) return null;

  const readInteger = (): Uint8Array | null => {
    if (der[offset++] !== 0x02) return null;
    const len = readLength();
    if (len === null || len === 0 || offset + len > der.length) return null;
    const value = der.subarray(offset, offset + len);
    offset += len;
    // Strip leading zeros (DER sign padding), then left-pad to the fixed
    // 32-byte width raw form requires.
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start++;
    const trimmed = value.subarray(start);
    if (trimmed.length > 32) return null;
    const fixed = new Uint8Array(32);
    fixed.set(trimmed, 32 - trimmed.length);
    return fixed;
  };

  const r = readInteger();
  const s = readInteger();
  if (r === null || s === null || offset !== der.length) return null;

  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/**
 * Create a verifier bound to one key resolver. Imported keys are cached per
 * key id — Circle's keys are static, so each id resolves at most once per
 * verifier for the process lifetime.
 */
export function createVerifier(options: VerifierOptions): NotificationVerifier {
  const { resolveKey } = options;
  const subtle = getSubtle();
  const keys = new Map<string, CryptoKeyLike>();

  // Resolve + import a key id, caching only success: a `null` (unknown id) is
  // not cached so a later legitimate rotation to that id is not locked out, and
  // a resolver/import failure is not cached so a transient outage heals.
  const keyFor = async (keyId: string): Promise<CryptoKeyLike | null> => {
    const cached = keys.get(keyId);
    if (cached !== undefined) return cached;

    const spkiBase64 = await resolveKey(keyId);
    if (spkiBase64 === null) return null;
    const spki = base64ToBytes(spkiBase64);
    if (spki === null) {
      // The resolver handed back something that is not a key — a configuration
      // problem on our side, not a bad request; surface it.
      throw new Error(`circle public key for ${keyId} is not valid base64`);
    }
    const key = await subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    keys.set(keyId, key);
    return key;
  };

  return {
    async verify(rawBody, signature, keyId) {
      if (keyId === "" || signature === "") return false;
      const key = await keyFor(keyId);
      if (key === null) return false;

      const der = base64ToBytes(signature);
      if (der === null) return false;
      const raw = derSignatureToRaw(der);
      if (raw === null) return false;

      const body = typeof rawBody === "string" ? encodeUtf8(rawBody) : rawBody;
      return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, body);
    },
  };
}
