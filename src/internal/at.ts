/**
 * Reads `array[index]` where the surrounding loop bounds already guarantee the index exists.
 * With `noUncheckedIndexedAccess` every indexed read is typed as possibly `undefined`; this
 * helper states the invariant once and fails loudly if it is ever broken.
 */
export function at<T>(array: ArrayLike<T>, index: number): T {
  const value = array[index];
  if (value === undefined) {
    throw new RangeError(`Index ${index} is out of bounds (length ${array.length})`);
  }
  return value;
}
