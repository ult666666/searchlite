/**
 * The Porter stemming algorithm, implemented from the original paper:
 * M. F. Porter, "An algorithm for suffix stripping", Program 14(3), 1980, pp. 130–137.
 *
 * Vocabulary used below (all defined in the paper):
 * - A consonant is a letter other than a, e, i, o, u, and other than a "y" that follows a
 *   consonant. Everything else is a vowel. C is a run of consonants, V a run of vowels.
 * - Every word has the form [C](VC)^m[V]; m is the word's "measure". "tree" has m = 0,
 *   "trouble" m = 1, "troubles" m = 2.
 * - *v*  the stem contains a vowel.
 * - *d   the stem ends with a double consonant ("-tt", "-ss").
 * - *o   the stem ends consonant-vowel-consonant where the last consonant is not w, x or y
 *        ("-wil", "-hop"); this guards short words such as "hop" or "fil(ing)".
 *
 * This follows the 1980 paper rather than the later reference C implementation: step 2 uses
 * "abli → able" and has no "logi → log" rule. Like the reference implementation, words of one
 * or two letters are returned unchanged, and so is anything that is not plain a–z (numbers,
 * other scripts), because the rules only make sense for English words.
 */

type Condition = (stem: string) => boolean;

interface SuffixRule {
  readonly suffix: string;
  readonly replacement: string;
  readonly condition: Condition;
}

/** Consonant flags for each letter, per Porter's definition (y depends on the letter before). */
function consonantFlags(word: string): boolean[] {
  const flags: boolean[] = [];
  for (const letter of word) {
    if ('aeiou'.includes(letter)) {
      flags.push(false);
    } else if (letter === 'y') {
      const previous = flags.at(-1);
      // "y" is a consonant at the start of a word or after a vowel, and a vowel after a consonant.
      flags.push(previous === undefined || !previous);
    } else {
      flags.push(true);
    }
  }
  return flags;
}

/** Porter's m: how many times a vowel run is followed by a consonant run. */
function measure(stem: string): number {
  let m = 0;
  let previous: boolean | undefined;
  for (const consonant of consonantFlags(stem)) {
    if (consonant && previous === false) {
      m++;
    }
    previous = consonant;
  }
  return m;
}

function containsVowel(stem: string): boolean {
  return consonantFlags(stem).includes(false);
}

function endsWithDoubleConsonant(stem: string): boolean {
  const length = stem.length;
  return (
    length >= 2 &&
    stem.charAt(length - 1) === stem.charAt(length - 2) &&
    consonantFlags(stem).at(-1) === true
  );
}

function endsConsonantVowelConsonant(stem: string): boolean {
  const flags = consonantFlags(stem);
  return (
    flags.length >= 3 &&
    flags.at(-3) === true &&
    flags.at(-2) === false &&
    flags.at(-1) === true &&
    !'wxy'.includes(stem.charAt(stem.length - 1))
  );
}

const measureAbove = (threshold: number): Condition => {
  return (stem) => measure(stem) > threshold;
};

function rules(condition: Condition, pairs: readonly (readonly [string, string])[]): SuffixRule[] {
  return pairs.map(([suffix, replacement]) => ({ suffix, replacement, condition }));
}

/**
 * Within one step only the rule with the longest matching suffix is considered. If its condition
 * fails, the step leaves the word alone; it does not fall back to a shorter suffix.
 */
function applyLongestMatch(word: string, stepRules: readonly SuffixRule[]): string {
  let best: SuffixRule | undefined;
  for (const rule of stepRules) {
    if (word.endsWith(rule.suffix) && (!best || rule.suffix.length > best.suffix.length)) {
      best = rule;
    }
  }
  if (!best) {
    return word;
  }
  const stem = word.slice(0, word.length - best.suffix.length);
  return best.condition(stem) ? stem + best.replacement : word;
}

const STEP_2 = rules(measureAbove(0), [
  ['ational', 'ate'],
  ['tional', 'tion'],
  ['enci', 'ence'],
  ['anci', 'ance'],
  ['izer', 'ize'],
  ['abli', 'able'],
  ['alli', 'al'],
  ['entli', 'ent'],
  ['eli', 'e'],
  ['ousli', 'ous'],
  ['ization', 'ize'],
  ['ation', 'ate'],
  ['ator', 'ate'],
  ['alism', 'al'],
  ['iveness', 'ive'],
  ['fulness', 'ful'],
  ['ousness', 'ous'],
  ['aliti', 'al'],
  ['iviti', 'ive'],
  ['biliti', 'ble'],
]);

const STEP_3 = rules(measureAbove(0), [
  ['icate', 'ic'],
  ['ative', ''],
  ['alize', 'al'],
  ['iciti', 'ic'],
  ['ical', 'ic'],
  ['ful', ''],
  ['ness', ''],
]);

const STEP_4: SuffixRule[] = [
  ...rules(measureAbove(1), [
    ['al', ''],
    ['ance', ''],
    ['ence', ''],
    ['er', ''],
    ['ic', ''],
    ['able', ''],
    ['ible', ''],
    ['ant', ''],
    ['ement', ''],
    ['ment', ''],
    ['ent', ''],
    ['ou', ''],
    ['ism', ''],
    ['ate', ''],
    ['iti', ''],
    ['ous', ''],
    ['ive', ''],
    ['ize', ''],
  ]),
  // "ion" is only removed after s or t: "adoption" → "adopt", but "onion" keeps its ending.
  {
    suffix: 'ion',
    replacement: '',
    condition: (stem) => measure(stem) > 1 && (stem.endsWith('s') || stem.endsWith('t')),
  },
];

/** Step 1a: plurals. caresses → caress, ponies → poni, caress → caress, cats → cat. */
function step1a(word: string): string {
  if (word.endsWith('sses') || word.endsWith('ies')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('ss')) {
    return word;
  }
  if (word.endsWith('s')) {
    return word.slice(0, -1);
  }
  return word;
}

/** Step 1b: past tenses and gerunds. agreed → agree, plastered → plaster, motoring → motor. */
function step1b(word: string): string {
  if (word.endsWith('eed')) {
    const stem = word.slice(0, -3);
    return measure(stem) > 0 ? `${stem}ee` : word;
  }
  for (const suffix of ['ed', 'ing']) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      return containsVowel(stem) ? tidyAfterStep1b(stem) : word;
    }
  }
  return word;
}

/**
 * After "-ed" or "-ing" is removed the stem may need repair: conflat(ed) → conflate,
 * hopp(ing) → hop, fil(ing) → file.
 */
function tidyAfterStep1b(stem: string): string {
  if (stem.endsWith('at') || stem.endsWith('bl') || stem.endsWith('iz')) {
    return `${stem}e`;
  }
  if (endsWithDoubleConsonant(stem) && !/[lsz]$/.test(stem)) {
    return stem.slice(0, -1);
  }
  if (measure(stem) === 1 && endsConsonantVowelConsonant(stem)) {
    return `${stem}e`;
  }
  return stem;
}

/** Step 1c: a final y becomes i when the stem has a vowel. happy → happi, sky → sky. */
function step1c(word: string): string {
  if (word.endsWith('y')) {
    const stem = word.slice(0, -1);
    if (containsVowel(stem)) {
      return `${stem}i`;
    }
  }
  return word;
}

/** Step 5a: drop a final e. probate → probat, rate → rate, cease → ceas. */
function step5a(word: string): string {
  if (word.endsWith('e')) {
    const stem = word.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !endsConsonantVowelConsonant(stem))) {
      return stem;
    }
  }
  return word;
}

/** Step 5b: -ll becomes -l on longer words. controll → control, roll → roll. */
function step5b(word: string): string {
  if (word.endsWith('l') && endsWithDoubleConsonant(word) && measure(word) > 1) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Reduces an English word to its stem so that related forms match: "connected", "connecting"
 * and "connections" all become "connect". Stems are not always real words ("relational" →
 * "relat"); they only need to be consistent between documents and queries.
 *
 * Expects lowercase input (the analyzer normalizes first).
 */
export function porterStem(word: string): string {
  if (word.length <= 2 || !/^[a-z]+$/.test(word)) {
    return word;
  }
  let stem = step1a(word);
  stem = step1b(stem);
  stem = step1c(stem);
  stem = applyLongestMatch(stem, STEP_2);
  stem = applyLongestMatch(stem, STEP_3);
  stem = applyLongestMatch(stem, STEP_4);
  stem = step5a(stem);
  return step5b(stem);
}
