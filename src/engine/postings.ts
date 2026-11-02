import { writeVarint } from '../structures/varint';

/**
 * Documents per block. A block is the unit that cursors skip over without decoding, and each block
 * keeps the data for its own score upper bound (block-max). Lucene also uses 128.
 */
export const BLOCK_SIZE = 128;
/** Blocks rewritten by `replace` or `remove` are split once they grow past this size. */
const MAX_BLOCK_SIZE = 2 * BLOCK_SIZE;
/** A document number above every real one: what a cursor reports once it is exhausted. */
export const NO_MORE_DOCUMENTS = Number.POSITIVE_INFINITY;

/** Lists whose bytes outgrow this move from the shared arena to a buffer of their own. */
const OWN_BUFFER_BYTES = 4096;
/** Skip entry fields: first document, last document, end byte, document count, impacts start. */
const STRIDE = 5;
const FIRST = 0;
const LAST = 1;
const END = 2;
const COUNT = 3;
const IMPACTS = 4;

/** One decoded posting: a document and the sorted positions of the term in it. */
export interface Posting {
  document: number;
  positions: number[];
}

/**
 * One growable byte buffer shared by the small postings lists of a field. A separate `Uint8Array`
 * per list would cost about 200 bytes of object headers, more than most rare terms' postings.
 * Each list owns a region of the buffer; a list that outgrows its region moves to a new one at
 * the end, and {@link compact} reclaims the abandoned regions. Lists larger than 4 KiB move to a
 * buffer of their own, where the header cost is negligible and growth leaves no garbage here.
 */
export class PostingsArena {
  bytes = new Uint8Array(1024);
  /** End of the last region handed out. */
  used = 0;
  /** Bytes in regions that lists have moved out of. */
  garbage = 0;

  /** Hands out `size` bytes at the end and returns their offset. */
  allocate(size: number): number {
    if (this.used + size > this.bytes.length) {
      const grown = new Uint8Array(Math.max(this.used + size, Math.ceil(this.bytes.length * 1.5)));
      grown.set(this.bytes.subarray(0, this.used));
      this.bytes = grown;
    }
    const offset = this.used;
    this.used += size;
    return offset;
  }

  /** Whether abandoned regions take up enough room to be worth a {@link compact}. */
  get wasteful(): boolean {
    return this.garbage > 64 * 1024 && this.garbage > this.used / 2;
  }

  /** Copies the live regions of `lists` into a fresh buffer, leaving each a quarter to grow. */
  compact(lists: Iterable<PostingsList>): void {
    const live = [...lists].filter((list) => list.own === undefined);
    let total = 0;
    for (const list of live) total += list.size + (list.size >> 2);
    const bytes = new Uint8Array(Math.max(1024, total));
    let offset = 0;
    for (const list of live) {
      bytes.set(this.bytes.subarray(list.offset, list.offset + list.size), offset);
      list.offset = offset;
      list.capacity = list.size + (list.size >> 2);
      offset += list.capacity;
    }
    this.bytes = bytes;
    this.used = offset;
    this.garbage = 0;
  }
}

/**
 * The postings of one term in one field, compressed with delta and variable-byte coding.
 *
 * Documents are kept in ascending order and grouped into blocks of {@link BLOCK_SIZE}. Each
 * posting is written as the gap from the previous document in its block (the block's first
 * document is in its skip entry instead), the term frequency, the first position, and the gaps
 * between later positions. All of these are variable-byte integers, so a posting of a term that
 * occurs once usually takes three bytes. The bytes live in the field's {@link PostingsArena}.
 *
 * `meta` starts with one skip entry per block: its first and last document, where its bytes end
 * (relative to the list's region), how many documents it holds and where its impacts start. A
 * cursor that needs document `t` passes over every block whose last document is below `t`
 * without decoding it.
 *
 * After the skip entries, `meta` holds each block's impacts: the Pareto frontier of its
 * (term frequency, field length) pairs, the pairs that no other posting in the block beats on
 * both counts (at least as frequent and at most as long). BM25 grows with frequency and shrinks
 * with length, so the best score in a block is reached at one of these pairs whatever the
 * average field length is when a query runs. Lucene stores the same idea as "impacts".
 *
 * New documents get increasing numbers, so indexing only ever appends to the last block. Removing
 * a document, or `replace` putting one back under its old number, rewrites only the block that
 * holds it.
 */
export class PostingsList {
  readonly arena: PostingsArena;
  /** The list's own buffer once it outgrows the arena; undefined while it lives in the arena. */
  own: Uint8Array | undefined;
  /** Start of this list's bytes in {@link bytes}, the room it has and how much of it is used. */
  offset = 0;
  capacity = 0;
  size = 0;
  /** Number of documents in the list: the term's document frequency in this field. */
  count = 0;
  blockCount = 0;
  /** Skip entries ({@link STRIDE} numbers per block), then every block's impact pairs. */
  meta: number[] = [];

  constructor(arena: PostingsArena) {
    this.arena = arena;
  }

  /** The buffer holding this list's bytes, which start at {@link offset}. */
  get bytes(): Uint8Array {
    return this.own ?? this.arena.bytes;
  }

  /** The last document number in the list, or -1 if it is empty. */
  get lastDocument(): number {
    return this.blockCount === 0 ? -1 : this.blockLast(this.blockCount - 1);
  }

  blockFirst(block: number): number {
    return this.meta[block * STRIDE + FIRST] ?? NO_MORE_DOCUMENTS;
  }

  blockLast(block: number): number {
    return this.meta[block * STRIDE + LAST] ?? NO_MORE_DOCUMENTS;
  }

  blockSize(block: number): number {
    return this.meta[block * STRIDE + COUNT] ?? 0;
  }

  /** Offset of a block's first byte within this list's region. */
  blockStart(block: number): number {
    return block === 0 ? 0 : (this.meta[(block - 1) * STRIDE + END] ?? 0);
  }

  blockEnd(block: number): number {
    return this.meta[block * STRIDE + END] ?? 0;
  }

  /** Start and end, in `meta`, of a block's flattened (frequency, length) pairs. */
  impactRange(block: number): [number, number] {
    const start = this.meta[block * STRIDE + IMPACTS] ?? 0;
    const end =
      block + 1 < this.blockCount
        ? (this.meta[(block + 1) * STRIDE + IMPACTS] ?? 0)
        : this.meta.length;
    return [start, end];
  }

  /**
   * Adds a document. `lengths` gives every document's length in this field (indexed by document
   * number); it is read only when a block in the middle has to be rewritten.
   */
  add(document: number, positions: readonly number[], lengths: readonly number[]): void {
    if (document > this.lastDocument) {
      this.#append(document, positions, lengths[document] ?? 0);
      return;
    }
    const block = this.#blockFor(document);
    const postings = this.decodeBlock(block);
    const at = postings.findIndex((posting) => posting.document >= document);
    if (postings[at]?.document === document) {
      postings[at] = { document, positions: [...positions] };
    } else {
      postings.splice(at === -1 ? postings.length : at, 0, {
        document,
        positions: [...positions],
      });
      this.count++;
    }
    this.#rewrite(block, postings, lengths);
  }

  /**
   * Gives this list's arena region back as garbage, for a list its field is dropping because it
   * no longer holds any document. Without this, the regions of deleted terms would be neither
   * live nor garbage, so compaction would never reclaim them.
   */
  release(): void {
    if (this.own === undefined) {
      this.arena.garbage += this.capacity;
    }
    this.capacity = 0;
  }

  /** Removes a document. Returns false if the list does not contain it. */
  remove(document: number, lengths: readonly number[]): boolean {
    if (this.#find(document) < 0) {
      return false;
    }
    const block = this.#blockFor(document);
    const postings = this.decodeBlock(block).filter((posting) => posting.document !== document);
    this.count--;
    this.#rewrite(block, postings, lengths);
    return true;
  }

  /** The term frequency in one document, or 0 if the list does not contain it. */
  frequency(document: number): number {
    const offset = this.#find(document);
    return offset < 0 ? 0 : readVarint(this.bytes, offset).value;
  }

  /** The positions of the term in one document, or undefined if the list does not contain it. */
  positions(document: number): number[] | undefined {
    const offset = this.#find(document);
    return offset < 0 ? undefined : readPositions(this.bytes, offset).positions;
  }

  /** Every posting in document order. */
  decodeAll(): Posting[] {
    const postings: Posting[] = [];
    for (let block = 0; block < this.blockCount; block++) {
      postings.push(...this.decodeBlock(block));
    }
    return postings;
  }

  /** Decodes one block completely, positions included. */
  decodeBlock(block: number): Posting[] {
    const bytes = this.bytes;
    const postings: Posting[] = [];
    let offset = this.offset + this.blockStart(block);
    let document = this.blockFirst(block);
    for (let i = 0, count = this.blockSize(block); i < count; i++) {
      if (i > 0) {
        const gap = readVarint(bytes, offset);
        document += gap.value;
        offset = gap.next;
      }
      const decoded = readPositions(bytes, offset);
      postings.push({ document, positions: decoded.positions });
      offset = decoded.next;
    }
    return postings;
  }

  /** The first block whose last document is at least `document` (there must be one). */
  #blockFor(document: number): number {
    let low = 0;
    let high = this.blockCount - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.blockLast(middle) < document) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  /**
   * Arena offset of a document's frequency, or -1 if the list does not contain it. Only the one
   * block that could hold the document is scanned, and nothing is allocated.
   */
  #find(document: number): number {
    if (this.count === 0 || document > this.lastDocument || document < 0) {
      return -1;
    }
    const block = this.#blockFor(document);
    const bytes = this.bytes;
    let offset = this.offset + this.blockStart(block);
    let current = this.blockFirst(block);
    for (let i = 0, count = this.blockSize(block); i < count; i++) {
      if (i > 0) {
        let byte = bytes[offset++] ?? 0;
        let gap = byte & 127;
        for (let scale = 128; byte >= 128; scale *= 128) {
          byte = bytes[offset++] ?? 0;
          gap += (byte & 127) * scale;
        }
        current += gap;
      }
      if (current >= document) {
        return current === document ? offset : -1;
      }
      offset = skipPositions(bytes, offset);
    }
    return -1;
  }

  #append(document: number, positions: readonly number[], length: number): void {
    const meta = this.meta;
    const last = this.blockCount - 1;
    const open = last >= 0 && this.blockSize(last) < BLOCK_SIZE;
    this.#reserve(8 * (positions.length + 2));
    const bytes = this.bytes;
    let offset = this.offset + this.size;
    if (open) {
      offset = writeVarint(bytes, offset, document - this.lastDocument);
    }
    offset = writePositions(bytes, offset, positions);
    this.size = offset - this.offset;
    this.count++;
    if (open) {
      const entry = last * STRIDE;
      meta[entry + LAST] = document;
      meta[entry + END] = this.size;
      meta[entry + COUNT] = (meta[entry + COUNT] ?? 0) + 1;
      addImpact(meta, meta[entry + IMPACTS] ?? 0, positions.length, length);
    } else if (last < 0) {
      // An exactly sized literal: arrays grown by push keep spare capacity.
      this.meta = [document, document, this.size, 1, STRIDE, positions.length, length];
      this.blockCount = 1;
    } else {
      // A new skip entry goes before the impacts, which therefore move up by one entry.
      for (let block = 0; block < this.blockCount; block++) {
        meta[block * STRIDE + IMPACTS] = (meta[block * STRIDE + IMPACTS] ?? 0) + STRIDE;
      }
      const start = meta.length + STRIDE;
      meta.splice(this.blockCount * STRIDE, 0, document, document, this.size, 1, start);
      meta.push(positions.length, length);
      this.blockCount++;
    }
  }

  /** Replaces block `block` with `postings` (possibly none, possibly split into several blocks). */
  #rewrite(block: number, postings: readonly Posting[], lengths: readonly number[]): void {
    const chunks: (readonly Posting[])[] = [];
    if (postings.length > MAX_BLOCK_SIZE) {
      for (let i = 0; i < postings.length; i += BLOCK_SIZE) {
        chunks.push(postings.slice(i, i + BLOCK_SIZE));
      }
    } else if (postings.length > 0) {
      chunks.push(postings);
    }
    const encoded = chunks.map((chunk) => encodeBlock(chunk));
    const start = this.blockStart(block);
    const end = this.blockEnd(block);
    const added = encoded.reduce((sum, bytes) => sum + bytes.length, 0);
    const delta = added - (end - start);
    this.#reserve(Math.max(0, delta));
    const bytes = this.bytes;
    bytes.copyWithin(this.offset + start + added, this.offset + end, this.offset + this.size);
    let offset = this.offset + start;
    for (const chunk of encoded) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    this.size += delta;

    // Rebuild the skip entries and impacts: blocks before, the rewritten ones, blocks after.
    const entries: number[][] = [];
    const impacts: number[][] = [];
    for (let b = 0; b < this.blockCount; b++) {
      if (b === block) {
        let blockEnd = start;
        chunks.forEach((chunk, c) => {
          blockEnd += encoded[c]?.length ?? 0;
          const pairs: number[] = [];
          for (const posting of chunk) {
            addImpact(pairs, 0, posting.positions.length, lengths[posting.document] ?? 0);
          }
          entries.push([
            chunk[0]?.document ?? 0,
            chunk.at(-1)?.document ?? 0,
            blockEnd,
            chunk.length,
          ]);
          impacts.push(pairs);
        });
        continue;
      }
      const entry = b * STRIDE;
      const shift = b > block ? delta : 0;
      const [from, to] = this.impactRange(b);
      entries.push([
        this.blockFirst(b),
        this.blockLast(b),
        this.blockEnd(b) + shift,
        this.meta[entry + COUNT] ?? 0,
      ]);
      impacts.push(this.meta.slice(from, to));
    }
    const meta: number[] = [];
    let impactStart = entries.length * STRIDE;
    entries.forEach((entry, e) => {
      meta.push(...entry, impactStart);
      impactStart += impacts[e]?.length ?? 0;
    });
    for (const pairs of impacts) meta.push(...pairs);
    this.meta = meta;
    this.blockCount = entries.length;
  }

  /** Makes room for `extra` more bytes, moving the list to a larger region if it must. */
  #reserve(extra: number): void {
    const needed = this.size + extra;
    if (needed <= this.capacity) {
      return;
    }
    const arena = this.arena;
    const capacity = Math.max(needed, this.capacity + (this.capacity >> 1) + 4);
    if (this.own || capacity > OWN_BUFFER_BYTES) {
      const own = new Uint8Array(capacity);
      own.set(this.bytes.subarray(this.offset, this.offset + this.size));
      if (!this.own) arena.garbage += this.capacity;
      this.own = own;
      this.offset = 0;
    } else {
      const offset = arena.allocate(capacity);
      arena.bytes.copyWithin(offset, this.offset, this.offset + this.size);
      arena.garbage += this.capacity;
      this.offset = offset;
    }
    this.capacity = capacity;
  }
}

/** Writes a posting's frequency and positions (first position, then gaps). */
function writePositions(bytes: Uint8Array, offset: number, positions: readonly number[]): number {
  let at = writeVarint(bytes, offset, positions.length);
  let previous = 0;
  positions.forEach((position, p) => {
    at = writeVarint(bytes, at, p === 0 ? position : position - previous);
    previous = position;
  });
  return at;
}

/** Encodes postings as one block: no gap for the first document, which the skip entry holds. */
function encodeBlock(postings: readonly Posting[]): Uint8Array {
  const bytes = new Uint8Array(
    postings.reduce((sum, posting) => sum + 8 * (posting.positions.length + 2), 0),
  );
  let offset = 0;
  let previous = 0;
  postings.forEach((posting, i) => {
    if (i > 0) {
      offset = writeVarint(bytes, offset, posting.document - previous);
    }
    offset = writePositions(bytes, offset, posting.positions);
    previous = posting.document;
  });
  return bytes.slice(0, offset);
}

/** Reads one trusted varint (written by this module) at `offset`. */
function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let next = offset;
  let byte = bytes[next++] ?? 0;
  let value = byte & 127;
  for (let scale = 128; byte >= 128; scale *= 128) {
    byte = bytes[next++] ?? 0;
    value += (byte & 127) * scale;
  }
  return { value, next };
}

/** Reads a frequency and that many positions starting at `offset`. */
function readPositions(bytes: Uint8Array, offset: number): { positions: number[]; next: number } {
  const frequency = readVarint(bytes, offset);
  const positions: number[] = [];
  let next = frequency.next;
  let position = 0;
  for (let p = 0; p < frequency.value; p++) {
    const step = readVarint(bytes, next);
    position = p === 0 ? step.value : position + step.value;
    positions.push(position);
    next = step.next;
  }
  return { positions, next };
}

/** Steps over a frequency and its positions; every varint ends with a byte below 128. */
function skipPositions(bytes: Uint8Array, offset: number): number {
  let next = offset;
  let byte = bytes[next++] ?? 0;
  let frequency = byte & 127;
  for (let scale = 128; byte >= 128; scale *= 128) {
    byte = bytes[next++] ?? 0;
    frequency += (byte & 127) * scale;
  }
  for (let p = 0; p < frequency; p++) {
    while ((bytes[next++] ?? 0) >= 128) {
      // continuation byte
    }
  }
  return next;
}

/**
 * Adds (frequency, length) to the Pareto frontier stored in `pairs` from `start` to the end: the
 * pair is dropped if an existing one is at least as frequent and at most as long, and existing
 * pairs that the new one beats are removed.
 */
function addImpact(pairs: number[], start: number, frequency: number, length: number): void {
  for (let i = start; i < pairs.length; i += 2) {
    if ((pairs[i] ?? 0) >= frequency && (pairs[i + 1] ?? 0) <= length) {
      return;
    }
  }
  const kept: number[] = [];
  for (let i = start; i < pairs.length; i += 2) {
    const f = pairs[i] ?? 0;
    const l = pairs[i + 1] ?? 0;
    if (!(f <= frequency && l >= length)) {
      kept.push(f, l);
    }
  }
  pairs.length = start;
  pairs.push(...kept, frequency, length);
}

/**
 * Walks one postings list in document order, decoding one block at a time.
 *
 * `advance(target)` passes over whole blocks whose last document is below `target` by reading
 * only the skip entries. `shallow(target)` moves a second, independent pointer to the block that
 * could contain `target`, so a caller can read that block's impacts (its score upper bound)
 * without decoding it. Both pointers only move forward.
 */
export class PostingsCursor {
  /** The current document: -1 before the first `advance`, {@link NO_MORE_DOCUMENTS} at the end. */
  document = -1;
  readonly list: PostingsList;
  #block = -1;
  #index = 0;
  // Decoded documents, frequencies and position offsets of the current block, allocated on first use.
  #documents = EMPTY_DOCUMENTS;
  #frequencies = EMPTY_COUNTS;
  #offsets = EMPTY_COUNTS;
  #shallowBlock = 0;

  constructor(list: PostingsList) {
    this.list = list;
  }

  /** Term frequency in the current document. */
  get frequency(): number {
    return this.#frequencies[this.#index] ?? 0;
  }

  /** Moves to the first document at or after `target` and returns it. */
  advance(target: number): number {
    if (target <= this.document) {
      return this.document;
    }
    const list = this.list;
    let block = this.#block;
    if (block < 0 || target > list.blockLast(block)) {
      const blocks = list.blockCount;
      block = Math.max(block + 1, 0);
      while (block < blocks && list.blockLast(block) < target) {
        block++;
      }
      if (block >= blocks) {
        this.document = NO_MORE_DOCUMENTS;
        return NO_MORE_DOCUMENTS;
      }
      this.#decode(block);
    }
    const documents = this.#documents;
    let index = this.#index;
    while ((documents[index] ?? NO_MORE_DOCUMENTS) < target) {
      index++;
    }
    this.#index = index;
    this.document = documents[index] ?? NO_MORE_DOCUMENTS;
    return this.document;
  }

  /** The positions of the term in the current document, written into `out`. */
  positions(out: number[]): number[] {
    const bytes = this.list.bytes;
    const frequency = this.frequency;
    let offset = this.#offsets[this.#index] ?? 0;
    let position = 0;
    out.length = 0;
    for (let p = 0; p < frequency; p++) {
      let byte = bytes[offset++] ?? 0;
      let value = byte & 127;
      for (let scale = 128; byte >= 128; scale *= 128) {
        byte = bytes[offset++] ?? 0;
        value += (byte & 127) * scale;
      }
      position = p === 0 ? value : position + value;
      out.push(position);
    }
    return out;
  }

  /**
   * Moves the shallow pointer to the first block whose last document is at least `target` and
   * returns that block's index, or -1 if no block is left. Targets must not decrease.
   */
  shallow(target: number): number {
    const list = this.list;
    const blocks = list.blockCount;
    let block = this.#shallowBlock;
    while (block < blocks && list.blockLast(block) < target) {
      block++;
    }
    this.#shallowBlock = block;
    return block < blocks ? block : -1;
  }

  #decode(block: number): void {
    const list = this.list;
    const count = list.blockSize(block);
    if (count > this.#documents.length) {
      const capacity = Math.max(count, Math.min(list.count, BLOCK_SIZE));
      this.#documents = new Float64Array(capacity);
      this.#frequencies = new Uint32Array(capacity);
      this.#offsets = new Uint32Array(capacity);
    }
    const documents = this.#documents;
    const frequencies = this.#frequencies;
    const offsets = this.#offsets;
    const bytes = list.bytes;
    let offset = list.offset + list.blockStart(block);
    let document = list.blockFirst(block);
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        let byte = bytes[offset++] ?? 0;
        let gap = byte & 127;
        for (let scale = 128; byte >= 128; scale *= 128) {
          byte = bytes[offset++] ?? 0;
          gap += (byte & 127) * scale;
        }
        document += gap;
      }
      documents[i] = document;
      let byte = bytes[offset++] ?? 0;
      let frequency = byte & 127;
      for (let scale = 128; byte >= 128; scale *= 128) {
        byte = bytes[offset++] ?? 0;
        frequency += (byte & 127) * scale;
      }
      frequencies[i] = frequency;
      offsets[i] = offset;
      for (let p = 0; p < frequency; p++) {
        while ((bytes[offset++] ?? 0) >= 128) {
          // continuation byte
        }
      }
    }
    this.#block = block;
    this.#index = 0;
  }
}

const EMPTY_DOCUMENTS = new Float64Array(0);
const EMPTY_COUNTS = new Uint32Array(0);

/** Number of distinct documents in the union of several lists, without decoding the largest. */
export function unionSize(lists: readonly PostingsList[]): number {
  const [largest, ...rest] = [...lists].sort((a, b) => b.count - a.count);
  if (!largest) {
    return 0;
  }
  if (rest.length === 0) {
    return largest.count;
  }
  const probe = new PostingsCursor(largest);
  const cursors = rest.map((list) => new PostingsCursor(list));
  let size = largest.count;
  let document = Math.min(...cursors.map((cursor) => cursor.advance(0)));
  while (document !== NO_MORE_DOCUMENTS) {
    if (probe.advance(document) !== document) {
      size++;
    }
    let next = NO_MORE_DOCUMENTS;
    for (const cursor of cursors) {
      const current = cursor.document === document ? cursor.advance(document + 1) : cursor.document;
      next = Math.min(next, current);
    }
    document = next;
  }
  return size;
}
