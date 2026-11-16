// Compatibility only: use maintained implementations for every primitive.
import crypto from "@jspm/core/nodelibs/crypto";
import { hkdf as deriveHkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { equalBytes } from "@noble/ciphers/utils.js";

export * from "@jspm/core/nodelibs/crypto";

function bytes(value) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Expected a string or bytes");
}

export function hkdf(digest, input, salt, info, length, callback) {
  // LINEJS encrypted attachments use exactly this digest. Fail closed if the
  // upstream package introduces another algorithm rather than substituting one.
  queueMicrotask(() => {
    let result;
    try {
      if (digest !== "sha256") throw new TypeError("Unsupported HKDF digest");
      result = deriveHkdf(sha256, bytes(input), bytes(salt), bytes(info), length);
    } catch (error) {
      callback(error);
      return;
    }
    callback(null, result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength));
  });
}

export function timingSafeEqual(left, right) {
  const a = bytes(left);
  const b = bytes(right);
  if (a.byteLength !== b.byteLength) throw new RangeError("Inputs must have equal byte lengths");
  return equalBytes(a, b);
}

export default { ...crypto, hkdf, timingSafeEqual };
