import { at } from '../internal/at';

/**
 * Keeps the `k` best items seen so far using a binary min-heap of size `k`.
 *
 * The heap is ordered so that its root is the *worst* item kept. A new item only has to beat
 * the root to get in, and then it replaces the root and sinks to its place. Selecting the top
 * k of n scored documents therefore costs O(n log k) time and O(k) memory, instead of the
 * O(n log n) of sorting every match.
 */
export class TopK<T> {
  readonly #capacity: number;
  readonly #isBetter: (a: T, b: T) => boolean;
  readonly #heap: T[] = [];

  /**
   * @param capacity - How many items to keep. `Infinity` keeps everything.
   * @param isBetter - Strict ordering: returns true when `a` should rank above `b`.
   */
  constructor(capacity: number, isBetter: (a: T, b: T) => boolean) {
    this.#capacity = capacity;
    this.#isBetter = isBetter;
  }

  get size(): number {
    return this.#heap.length;
  }

  /** Offers an item; it is kept only if it is among the best `capacity` items so far. */
  push(item: T): void {
    const heap = this.#heap;
    if (heap.length < this.#capacity) {
      heap.push(item);
      this.#siftUp(heap.length - 1);
    } else if (heap.length > 0 && this.#isBetter(item, at(heap, 0))) {
      heap[0] = item;
      this.#siftDown(0);
    }
  }

  /** The kept items, best first. */
  sorted(): T[] {
    return [...this.#heap].sort((a, b) => {
      if (this.#isBetter(a, b)) {
        return -1;
      }
      return this.#isBetter(b, a) ? 1 : 0;
    });
  }

  /** Moves a newly appended item up while it is worse than its parent. */
  #siftUp(index: number): void {
    const heap = this.#heap;
    let child = index;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (!this.#isBetter(at(heap, parent), at(heap, child))) {
        return;
      }
      this.#swap(parent, child);
      child = parent;
    }
  }

  /** Moves the root down while one of its children is worse than it. */
  #siftDown(index: number): void {
    const heap = this.#heap;
    let parent = index;
    for (;;) {
      const left = 2 * parent + 1;
      const right = left + 1;
      let worst = parent;
      if (left < heap.length && this.#isBetter(at(heap, worst), at(heap, left))) {
        worst = left;
      }
      if (right < heap.length && this.#isBetter(at(heap, worst), at(heap, right))) {
        worst = right;
      }
      if (worst === parent) {
        return;
      }
      this.#swap(parent, worst);
      parent = worst;
    }
  }

  #swap(i: number, j: number): void {
    const heap = this.#heap;
    const item = at(heap, i);
    heap[i] = at(heap, j);
    heap[j] = item;
  }
}
