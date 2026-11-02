/**
 * Variable-byte integer coding (Manning, Raghavan and Schütze, _Introduction to Information
 * Retrieval_, 2008, section 5.3.1), in the little-endian base-128 layout used by Protocol Buffers
 * varints and Lucene's VInt: each byte holds seven bits of the value, lowest bits first, and its
 * high bit is set when another byte follows. Values 0..127 take one byte and 128..16383 take two;
 * 300 is written as 0xAC 0x02.
 *
 * Postings store small numbers (gaps between document numbers, frequencies, gaps between
 * positions), so most of them fit in one byte instead of the eight bytes of a JavaScript number.
 */

const TWO_POW_31 = 0x80000000;
/** Bytes in the longest varint of a safe integer: 2^53 − 1 needs ceil(53 / 7) = 8. */
const MAX_VARINT_BYTES = 8;

/** A growable byte buffer that varints are appended to. */
export class ByteWriter {
  bytes: Uint8Array;
  length = 0;

  constructor(capacity = 16) {
    this.bytes = new Uint8Array(capacity);
  }

  /** Makes room for at least `extra` more bytes, growing the buffer by half when it is full. */
  reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed > this.bytes.length) {
      const grown = new Uint8Array(Math.max(needed, Math.ceil(this.bytes.length * 1.5), 16));
      grown.set(this.bytes.subarray(0, this.length));
      this.bytes = grown;
    }
  }

  /** Appends a non-negative safe integer. */
  write(value: number): void {
    this.reserve(8);
    this.length = writeVarint(this.bytes, this.length, value);
  }

  /** A right-sized copy of the bytes written so far. */
  toBytes(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

/**
 * Writes `value` (a non-negative safe integer) at `offset` and returns the offset after it. The
 * caller guarantees room for eight bytes, which covers every integer below 2^56.
 */
export function writeVarint(bytes: Uint8Array, offset: number, value: number): number {
  let rest = value;
  let at = offset;
  while (rest >= TWO_POW_31) {
    bytes[at++] = (rest % 128) + 128;
    rest = Math.floor(rest / 128);
  }
  while (rest > 127) {
    bytes[at++] = (rest & 127) | 128;
    rest >>>= 7;
  }
  bytes[at++] = rest;
  return at;
}

/** Number of bytes `writeVarint` uses for `value`. */
export function varintLength(value: number): number {
  let length = 1;
  for (let rest = value; rest > 127; rest = Math.floor(rest / 128)) {
    length++;
  }
  return length;
}

/**
 * Reads varints from untrusted bytes (such as a snapshot) with full checks: a value may not run
 * past the end, use a non-canonical encoding (a final zero byte after a continuation) or exceed
 * 2^53 − 1, which also rules out anything longer than eight bytes. Every failure is a
 * `RangeError`.
 */
export class ByteReader {
  readonly bytes: Uint8Array;
  offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  read(): number {
    let value = 0;
    let scale = 1;
    for (let count = 0; ; count++) {
      // Eight bytes carry 56 bits. Checking the length (not only the value) matters: after
      // about 147 empty continuation bytes the scale is Infinity and 0 · Infinity is NaN.
      if (count === MAX_VARINT_BYTES) {
        throw new RangeError('Variable-byte integer exceeds 2^53 - 1');
      }
      const byte = this.bytes[this.offset++];
      if (byte === undefined) {
        throw new RangeError('Truncated variable-byte integer');
      }
      if (count > 0 && byte === 0) {
        throw new RangeError('Non-canonical variable-byte integer');
      }
      value += (byte & 127) * scale;
      if (value > Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Variable-byte integer exceeds 2^53 - 1');
      }
      if (byte < 128) {
        return value;
      }
      scale *= 128;
    }
  }
}
