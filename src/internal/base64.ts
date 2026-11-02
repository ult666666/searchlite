/**
 * Base64 with the standard alphabet and `=` padding (RFC 4648, section 4), written out here so
 * the library needs neither `Buffer` nor `btoa`. Snapshots use it to carry compressed postings
 * inside JSON.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CODES = new Uint8Array(128).fill(255);
for (let i = 0; i < ALPHABET.length; i++) {
  CODES[ALPHABET.charCodeAt(i)] = i;
}
const CHUNK = 0x2000;

function letter(value: number): number {
  return ALPHABET.charCodeAt(value);
}

export function encodeBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const word = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out[o++] = letter(word >>> 18);
    out[o++] = letter((word >>> 12) & 63);
    out[o++] = letter((word >>> 6) & 63);
    out[o++] = letter(word & 63);
  }
  const rest = bytes.length - i;
  if (rest > 0) {
    const word = ((bytes[i] ?? 0) << 16) | (rest === 2 ? (bytes[i + 1] ?? 0) << 8 : 0);
    out[o++] = letter(word >>> 18);
    out[o++] = letter((word >>> 12) & 63);
    out[o++] = rest === 2 ? letter((word >>> 6) & 63) : 61;
    out[o] = 61;
  }
  let text = '';
  for (let start = 0; start < out.length; start += CHUNK) {
    text += String.fromCharCode(...out.subarray(start, start + CHUNK));
  }
  return text;
}

/**
 * Decodes strictly: the length must be a multiple of four, every character must be in the
 * alphabet, padding may only end the text, and unused bits before the padding must be zero.
 * @throws {RangeError} on any malformed input.
 */
export function decodeBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) {
    throw new RangeError('Base64 length must be a multiple of 4');
  }
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const last = i + 4 === text.length;
    let word = 0;
    for (let j = 0; j < 4; j++) {
      const code = text.charCodeAt(i + j);
      const padded = last && j >= 4 - padding;
      const value = padded ? 0 : code < 128 ? (CODES[code] ?? 255) : 255;
      if (value === 255) {
        throw new RangeError(`Invalid base64 character at offset ${i + j}`);
      }
      word = (word << 6) | value;
    }
    const kept = last ? 3 - padding : 3;
    if (kept < 3 && (word & (kept === 1 ? 0xffff : 0xff)) !== 0) {
      throw new RangeError('Base64 padding bits must be zero');
    }
    out[o++] = word >>> 16;
    if (kept > 1) out[o++] = (word >>> 8) & 255;
    if (kept > 2) out[o++] = word & 255;
  }
  return out;
}
