import { decodeBase64, encodeBase64 } from '../internal/base64';
import { ByteReader, ByteWriter } from '../structures/varint';
import type { PostingsList } from './postings';

/**
 * Snapshot (version 2) form of one postings list: base64 of a stream of variable-byte integers.
 * For each document, in ascending slot order (the document's position in the snapshot's
 * `documents` array): the gap from the previous slot (the first slot counts from -1, so every
 * gap is at least 1), the term frequency, the first position, then the gaps between positions.
 */
export function encodePostingsPayload(
  list: PostingsList,
  slotOf: ReadonlyMap<number, number>,
): string {
  const writer = new ByteWriter(list.size + 8);
  let previous = -1;
  for (const { document, positions } of list.decodeAll()) {
    const slot = slotOf.get(document) ?? -1;
    writer.write(slot - previous);
    writer.write(positions.length);
    positions.forEach((position, p) => {
      writer.write(p === 0 ? position : position - (positions[p - 1] ?? 0));
    });
    previous = slot;
  }
  return encodeBase64(writer.toBytes());
}

/**
 * Parses {@link encodePostingsPayload} output, checking every value: slots must increase and
 * stay below `documentCount`, frequencies must be positive and positions must increase.
 * @throws {RangeError} if the payload is malformed.
 */
export function decodePostingsPayload(
  payload: string,
  documentCount: number,
): [number, number[]][] {
  const reader = new ByteReader(decodeBase64(payload));
  const postings: [number, number[]][] = [];
  let slot = -1;
  while (!reader.done) {
    const gap = reader.read();
    slot += gap;
    if (gap < 1 || slot >= documentCount) {
      throw new RangeError('Document slots must increase and stay within the snapshot');
    }
    const frequency = reader.read();
    if (frequency < 1) {
      throw new RangeError('Term frequencies must be positive');
    }
    const positions = [reader.read()];
    for (let p = 1; p < frequency; p++) {
      const step = reader.read();
      if (step < 1) {
        throw new RangeError('Positions must increase');
      }
      positions.push((positions[p - 1] ?? 0) + step);
    }
    if ((positions.at(-1) ?? 0) > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Positions must be safe integers');
    }
    postings.push([slot, positions]);
  }
  return postings;
}
