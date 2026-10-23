import { describe, expect, it } from 'vitest';
import { GLOSSARY } from '../corpus/glossary';
import { QUERIES } from '../corpus/queries';

describe('demo corpus', () => {
  it('has about 60 entries with unique ids and 2–4 sentence bodies', () => {
    expect(GLOSSARY.length).toBe(60);
    expect(new Set(GLOSSARY.map((entry) => entry.id)).size).toBe(GLOSSARY.length);
    for (const entry of GLOSSARY) {
      const sentences = entry.body.split(/(?<=[.!?])\s+/).length;
      expect(sentences, entry.id).toBeGreaterThanOrEqual(2);
      expect(sentences, entry.id).toBeLessThanOrEqual(4);
      expect(entry.tags.length, entry.id).toBeGreaterThan(0);
    }
  });

  it('only judges entries that exist, with grades 1–3 and one top answer per query', () => {
    const ids = new Set(GLOSSARY.map((entry) => entry.id));
    expect(new Set(QUERIES.map((query) => query.id)).size).toBe(QUERIES.length);
    for (const query of QUERIES) {
      const grades = Object.entries(query.judgements);
      expect(
        grades.some(([, grade]) => grade === 3),
        query.id,
      ).toBe(true);
      for (const [id, grade] of grades) {
        expect(ids.has(id), `${query.id} → ${id}`).toBe(true);
        expect([1, 2, 3]).toContain(grade);
      }
    }
  });
});
