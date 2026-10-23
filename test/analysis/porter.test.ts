import { describe, expect, it } from 'vitest';
import { porterStem } from '../../src/analysis/porter';

/**
 * Worked examples from Porter (1980). The paper shows what each individual step does; the
 * expected values here are the result of running the *whole* algorithm, worked out by hand
 * step by step (for example "relational" becomes "relate" in step 2 and "relat" in step 5a).
 */
const PAPER_EXAMPLES: Record<string, Record<string, string>> = {
  'step 1a': {
    caresses: 'caress',
    ponies: 'poni',
    ties: 'ti',
    caress: 'caress',
    cats: 'cat',
  },
  'step 1b': {
    feed: 'feed',
    agreed: 'agre', // step 1b gives "agree", step 5a then drops the final e (m = 1, not *o)
    plastered: 'plaster',
    bled: 'bled',
    motoring: 'motor',
    sing: 'sing',
    conflated: 'conflat',
    troubled: 'troubl',
    sized: 'size',
    hopping: 'hop',
    tanned: 'tan',
    falling: 'fall',
    hissing: 'hiss',
    fizzed: 'fizz',
    failing: 'fail',
    filing: 'file',
  },
  'step 1c': {
    happy: 'happi',
    sky: 'sky',
  },
  'step 2': {
    relational: 'relat',
    conditional: 'condit',
    rational: 'ration',
    valenci: 'valenc',
    hesitanci: 'hesit',
    digitizer: 'digit',
    conformabli: 'conform',
    radicalli: 'radic',
    differentli: 'differ',
    vileli: 'vile',
    analogousli: 'analog',
    vietnamization: 'vietnam',
    predication: 'predic',
    operator: 'oper',
    feudalism: 'feudal',
    decisiveness: 'decis',
    hopefulness: 'hope',
    callousness: 'callous',
    formaliti: 'formal',
    sensitiviti: 'sensit',
    sensibiliti: 'sensibl',
  },
  'step 3': {
    triplicate: 'triplic',
    formative: 'form',
    formalize: 'formal',
    electriciti: 'electr',
    electrical: 'electr',
    hopeful: 'hope',
    goodness: 'good',
  },
  'step 4': {
    revival: 'reviv',
    allowance: 'allow',
    inference: 'infer',
    airliner: 'airlin',
    gyroscopic: 'gyroscop',
    adjustable: 'adjust',
    defensible: 'defens',
    irritant: 'irrit',
    replacement: 'replac',
    adjustment: 'adjust',
    dependent: 'depend',
    adoption: 'adopt',
    homologou: 'homolog',
    communism: 'commun',
    activate: 'activ',
    angulariti: 'angular',
    homologous: 'homolog',
    effective: 'effect',
    bowdlerize: 'bowdler',
  },
  'step 5': {
    probate: 'probat',
    rate: 'rate',
    cease: 'ceas',
    controll: 'control',
    roll: 'roll',
  },
};

describe('porterStem', () => {
  for (const [step, examples] of Object.entries(PAPER_EXAMPLES)) {
    it(`reproduces the paper's ${step} examples`, () => {
      for (const [word, stem] of Object.entries(examples)) {
        expect(porterStem(word), word).toBe(stem);
      }
    });
  }

  it('conflates the classic "connect" family', () => {
    for (const word of ['connect', 'connected', 'connecting', 'connection', 'connections']) {
      expect(porterStem(word), word).toBe('connect');
    }
  });

  it('handles well-known longer derivations', () => {
    expect(porterStem('generalizations')).toBe('gener');
    expect(porterStem('oscillators')).toBe('oscil');
    expect(porterStem('nationalization')).toBe('nation');
    expect(porterStem('national')).toBe('nation');
    expect(porterStem('agreement')).toBe('agreement');
    expect(porterStem('easily')).toBe('easili');
    expect(porterStem('abilities')).toBe('abil');
    expect(porterStem('absolutely')).toBe('absolut');
  });

  it('maps inflections that matter for search onto one stem', () => {
    for (const word of ['index', 'indexes', 'indexing', 'indexed']) {
      expect(porterStem(word), word).toBe('index');
    }
    for (const word of ['search', 'searches', 'searched', 'searching']) {
      expect(porterStem(word), word).toBe('search');
    }
    for (const word of ['compute', 'computer', 'computing', 'computation', 'computational']) {
      expect(porterStem(word), word).toBe('comput');
    }
    expect(porterStem('running')).toBe('run');
    expect(porterStem('runs')).toBe('run');
  });

  it('treats y as a consonant at the start of a word and after a vowel', () => {
    expect(porterStem('yelling')).toBe('yell');
    expect(porterStem('enjoying')).toBe('enjoi');
    expect(porterStem('enjoyment')).toBe('enjoy');
  });

  it('leaves short words, numbers and non-Latin words untouched', () => {
    expect(porterStem('is')).toBe('is');
    expect(porterStem('as')).toBe('as');
    expect(porterStem('2024')).toBe('2024');
    expect(porterStem('mp3s')).toBe('mp3s');
    expect(porterStem('поиск')).toBe('поиск');
  });
});
