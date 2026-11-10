export const FRAME_TYPE_DELTA = 0x01;
export const FRAME_TYPE_SNAPSHOT = 0x02;
export const IV_BYTE_LENGTH = 12;

function getCrypto(): Crypto {
  if (typeof window !== "undefined" && window.crypto?.subtle) {
    return window.crypto;
  }
  if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }
  throw new Error("Web Crypto API (crypto.subtle) is not available in this environment.");
}

/**
 * Generates a UUIDv4 roomId and a 256-bit AES-GCM key, returning the key
 * encoded as a base64 JWK string for placement in window.location.hash.
 */
export async function createSession(): Promise<{ roomId: string; hashKey: string }> {
  const webCrypto = getCrypto();
  const roomId = webCrypto.randomUUID();
  const key = await webCrypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const exported = await webCrypto.subtle.exportKey("jwk", key);
  const hashKey = btoa(JSON.stringify(exported));
  return { roomId, hashKey };
}

/**
 * Imports a 256-bit AES-GCM CryptoKey from the URL hash fragment (#<base64Jwk>).
 * The hash fragment is never sent over HTTP or WebSocket connections.
 */
export async function importKeyFromHash(hashFragment: string): Promise<CryptoKey> {
  const webCrypto = getCrypto();
  const cleaned = hashFragment.startsWith("#") ? hashFragment.slice(1).trim() : hashFragment.trim();
  if (!cleaned) {
    throw new Error("Missing encryption key in URL hash fragment.");
  }

  let jwk: JsonWebKey;
  try {
    const jsonString = atob(decodeURIComponent(cleaned));
    jwk = JSON.parse(jsonString);
  } catch {
    throw new Error("Invalid encryption key format in URL hash fragment.");
  }

  if (jwk.kty !== "oct" || !jwk.k) {
    throw new Error("Malformed JWK symmetric key in URL hash fragment.");
  }

  return webCrypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts a binary Yjs delta or state vector using AES-GCM-256 with a fresh
 * 12-byte cryptographically random IV prepended to the ciphertext + 128-bit auth tag.
 */
export async function encryptDelta(delta: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const webCrypto = getCrypto();
  const iv = webCrypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const plainBuffer = new Uint8Array(delta).buffer;
  const ciphertext = await webCrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plainBuffer
  );
  const frame = new Uint8Array(IV_BYTE_LENGTH + ciphertext.byteLength);
  frame.set(iv, 0);
  frame.set(new Uint8Array(ciphertext), IV_BYTE_LENGTH);
  return frame;
}

/**
 * Decrypts a binary frame containing [12-byte IV][Ciphertext + 16-byte Auth Tag].
 */
export async function decryptDelta(frame: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  if (frame.byteLength <= IV_BYTE_LENGTH) {
    throw new Error("Encrypted frame is too short to contain a valid 12-byte IV and ciphertext.");
  }
  const webCrypto = getCrypto();
  const iv = frame.slice(0, IV_BYTE_LENGTH);
  const data = frame.slice(IV_BYTE_LENGTH);
  const decrypted = await webCrypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    new Uint8Array(data).buffer
  );
  return new Uint8Array(decrypted);
}

/**
 * Prepends a 1-byte protocol frame type (0x01 = delta, 0x02 = snapshot) to an encrypted frame.
 */
export function wrapEncryptedFrame(frameType: number, encryptedPayload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + encryptedPayload.byteLength);
  out[0] = frameType;
  out.set(encryptedPayload, 1);
  return out;
}

/**
 * Extracts the 1-byte frame type and the underlying [12-byte IV][Ciphertext] payload.
 */
export function unwrapEncryptedFrame(rawFrame: Uint8Array): {
  frameType: number;
  encryptedPayload: Uint8Array;
} {
  const firstByte = rawFrame[0];
  if (firstByte === FRAME_TYPE_DELTA || firstByte === FRAME_TYPE_SNAPSHOT) {
    return {
      frameType: firstByte,
      encryptedPayload: rawFrame.slice(1)
    };
  }
  return {
    frameType: FRAME_TYPE_DELTA,
    encryptedPayload: rawFrame
  };
}
