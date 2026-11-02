import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from '../../src/internal/base64';
import { ByteReader, ByteWriter, varintLength } from '../../src/structures/varint';

const bytesOf = (value: number): number[] => {
  const writer = new ByteWriter(1);
  writer.write(value);
  return [...writer.toBytes()];
};

describe('variable-byte integers', () => {
  it('matches the published Protocol Buffers varint examples', () => {
    // https://protobuf.dev/programming-guides/encoding/ (150 → 96 01) and the 300 → AC 02 example.
    expect(bytesOf(1)).toEqual([0x01]);
    expect(bytesOf(150)).toEqual([0x96, 0x01]);
    expect(bytesOf(300)).toEqual([0xac, 0x02]);
    expect(bytesOf(127)).toEqual([0x7f]);
    expect(bytesOf(128)).toEqual([0x80, 0x01]);
    expect(bytesOf(16384)).toEqual([0x80, 0x80, 0x01]);
    expect(bytesOf(2 ** 31)).toEqual([0x80, 0x80, 0x80, 0x80, 0x08]);
    expect(bytesOf(Number.MAX_SAFE_INTEGER)).toEqual([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f,
    ]);
  });

  it('round-trips random values of every length, including above 2^31', () => {
    let seed = 0x2545f491;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const values = [0, 127, 128, 16383, 16384, 2 ** 31 - 1, 2 ** 32, Number.MAX_SAFE_INTEGER];
    for (let i = 0; i < 2000; i++) {
      values.push(Math.floor(next() * 2 ** Math.floor(next() * 54)));
    }
    const writer = new ByteWriter(1);
    for (const value of values) writer.write(value);
    const reader = new ByteReader(writer.toBytes());
    for (const value of values) {
      const start = reader.offset;
      expect(reader.read()).toBe(value);
      expect(reader.offset - start).toBe(varintLength(value));
    }
    expect(reader.done).toBe(true);
  });

  it('refuses truncated, non-canonical and oversized input', () => {
    const read = (...bytes: number[]) => new ByteReader(Uint8Array.from(bytes)).read();
    expect(() => read()).toThrow(/Truncated/);
    expect(() => read(0x80)).toThrow(/Truncated/);
    expect(() => read(0x80, 0x00)).toThrow(/Non-canonical/);
    expect(() => read(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x10)).toThrow(/2\^53/);
    expect(() => read(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01)).toThrow(/2\^53/);
  });
});

describe('base64', () => {
  it('matches the RFC 4648 section 10 test vectors', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'Zg=='],
      ['fo', 'Zm8='],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg=='],
      ['fooba', 'Zm9vYmE='],
      ['foobar', 'Zm9vYmFy'],
    ];
    for (const [plain, encoded] of vectors) {
      const bytes = new TextEncoder().encode(plain);
      expect(encodeBase64(bytes)).toBe(encoded);
      expect(decodeBase64(encoded)).toEqual(bytes);
    }
  });

  it('agrees with Node.js Buffer on random bytes', () => {
    let seed = 7;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) & 255;
    for (const length of [1, 2, 3, 4, 5, 100, 8191, 8192, 8193, 30000]) {
      const bytes = Uint8Array.from({ length }, next);
      const encoded = Buffer.from(bytes).toString('base64');
      expect(encodeBase64(bytes)).toBe(encoded);
      expect(decodeBase64(encoded)).toEqual(bytes);
    }
  });

  it('decodes strictly', () => {
    for (const text of [
      'Zg=',
      'Zh==',
      'Zm9=',
      'Zm9v!A==',
      '=Zm9',
      'Zm=v',
      'Zg===',
      '====',
      'Zm9vé===',
    ]) {
      expect(() => decodeBase64(text), text).toThrow(RangeError);
    }
  });
});
