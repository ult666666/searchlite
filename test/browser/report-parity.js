import assert from 'node:assert/strict';

/**
 * Browser downloads and native stdout are produced by the same report code, but BM25F scores
 * call Math.log and nDCG calls Math.log2. JavaScript engines may round those in the last place
 * differently (Chromium 153 and Node 22/24 differ on some of these values), so a browser report
 * cannot promise the same bytes as Node. It must still match everywhere else.
 */
export const NUMBER_TOLERANCE = 1e-12;

/** Replaces each JSON number token (never text inside strings) with `#`. */
export function maskNumbers(json) {
  let masked = '';
  for (let i = 0; i < json.length;) {
    const character = json[i];
    if (character === '"') {
      let end = i + 1;
      while (json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
      masked += json.slice(i, end + 1);
      i = end + 1;
    } else if (character === '-' || (character >= '0' && character <= '9')) {
      let end = i + 1;
      while (end < json.length && /[\d.eE+-]/.test(json[end])) end++;
      masked += '#';
      i = end;
    } else {
      masked += character;
      i++;
    }
  }
  return masked;
}

function compareValues(actual, expected, path) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (Number.isInteger(actual) && Number.isInteger(expected)) {
      assert.equal(actual, expected, `${path}: integers must be identical`);
      return;
    }
    const allowed = NUMBER_TOLERANCE * Math.max(1, Math.abs(actual), Math.abs(expected));
    assert.ok(
      Math.abs(actual - expected) <= allowed,
      `${path}: ${actual} differs from native ${expected} by more than ${allowed}`,
    );
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array`);
    assert.equal(actual.length, expected.length, `${path}: array length`);
    expected.forEach((item, i) => {
      compareValues(actual[i], item, `${path}[${i}]`);
    });
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual), Object.keys(expected), `${path}: keys`);
    for (const key of Object.keys(expected))
      compareValues(actual[key], expected[key], `${path}.${key}`);
    return;
  }
  assert.equal(actual, expected, path);
}

/**
 * Asserts that a browser report matches native output: identical text apart from number
 * tokens, identical integers (ranks, grades, counts) and every other number within
 * NUMBER_TOLERANCE × max(1, |value|).
 */
export function assertSameReport(actual, expected, label = 'report') {
  assert.equal(maskNumbers(actual), maskNumbers(expected), `${label}: text outside numbers`);
  compareValues(JSON.parse(actual), JSON.parse(expected), label);
}
