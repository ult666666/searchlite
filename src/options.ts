import type { AnalyzerOptions } from './analysis/analyzer';
import { SearchliteError } from './errors';
import type { DefaultOperator } from './query/parser';

/** Analysis and scoring settings for one searchable field. */
export interface FieldOptions extends AnalyzerOptions {
  /**
   * BM25F weight for the field: its term frequencies are multiplied by this before they are
   * combined with other fields. Default 1.
   */
  boost?: number;
  /** Length normalization for this field, from 0 (none) to 1 (full). Defaults to the index's `b`. */
  b?: number;
}

export interface IndexOptions {
  /**
   * Searchable fields. Either a list of names (all with default settings) or an object mapping
   * each name to its {@link FieldOptions}. Field names must be identifiers (letters, digits and
   * underscores, not starting with a digit) so that queries can refer to them as `name:term`.
   */
  fields: readonly string[] | Readonly<Record<string, FieldOptions>>;
  /**
   * Document properties to keep and return with results. Defaults to the searchable fields.
   * Highlighting needs the field's original text, so highlighted fields must be stored.
   */
  storeFields?: readonly string[];
  /** Property that holds each document's unique id (a string or number). Default "id". */
  idField?: string;
  /** Property that holds an embedding vector (array of numbers) for hybrid search. */
  vectorField?: string;
  /** BM25 term-frequency saturation k1. Default 1.2. */
  k1?: number;
  /** Default BM25 length normalization b for every field. Default 0.75. */
  b?: number;
  /** Operator between terms with no explicit AND/OR. Default "OR". */
  defaultOperator?: DefaultOperator;
}

/** A field's settings with every default filled in. */
export interface ResolvedFieldOptions {
  name: string;
  boost: number;
  b: number;
  stemming: boolean;
  stopwords: boolean | string[];
}

/** Index options with every default filled in. This is what a snapshot stores. */
export interface ResolvedIndexOptions {
  fields: ResolvedFieldOptions[];
  storeFields: string[];
  idField: string;
  vectorField?: string;
  k1: number;
  b: number;
  defaultOperator: DefaultOperator;
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function invalid(message: string): SearchliteError {
  return new SearchliteError('INVALID_OPTIONS', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberInRange(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    const range =
      max === Number.POSITIVE_INFINITY ? `at least ${min}` : `between ${min} and ${max}`;
    throw invalid(`${name} must be a finite number ${range}, got ${String(value)}`);
  }
  return value;
}

function positiveNumber(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalid(`${name} must be a finite number greater than 0, got ${String(value)}`);
  }
  return value;
}

function nonEmptyString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw invalid(`${name} must be a non-empty string`);
  }
  return value;
}

function stringList(name: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalid(`${name} must be an array of strings`);
  }
  return [...(value as string[])];
}

/** Validates user options and fills in defaults. */
export function resolveIndexOptions(options: IndexOptions): ResolvedIndexOptions {
  if (!isRecord(options)) {
    throw invalid('Index options must be an object');
  }
  const k1 = options.k1 === undefined ? 1.2 : numberInRange('k1', options.k1, 0, Infinity);
  const b = options.b === undefined ? 0.75 : numberInRange('b', options.b, 0, 1);

  const entries: [string, unknown][] = Array.isArray(options.fields)
    ? (options.fields as unknown[]).map((name) => [String(name), {}])
    : isRecord(options.fields)
      ? Object.entries(options.fields)
      : [];
  if (entries.length === 0) {
    throw invalid('fields must name at least one searchable field');
  }
  const fields = entries.map(([name, fieldOptions]): ResolvedFieldOptions => {
    if (!FIELD_NAME.test(name)) {
      throw invalid(
        `Field name "${name}" must start with a letter or underscore and contain only letters, digits and underscores`,
      );
    }
    if (!isRecord(fieldOptions)) {
      throw invalid(`Options for field "${name}" must be an object`);
    }
    const { boost, b: fieldB, stemming, stopwords } = fieldOptions;
    if (stemming !== undefined && typeof stemming !== 'boolean') {
      throw invalid(`fields.${name}.stemming must be a boolean`);
    }
    return {
      name,
      boost: boost === undefined ? 1 : positiveNumber(`fields.${name}.boost`, boost),
      b: fieldB === undefined ? b : numberInRange(`fields.${name}.b`, fieldB, 0, 1),
      stemming: stemming ?? true,
      stopwords:
        stopwords === undefined || typeof stopwords === 'boolean'
          ? (stopwords ?? true)
          : stringList(`fields.${name}.stopwords`, stopwords),
    };
  });
  const names = new Set(fields.map((field) => field.name));
  if (names.size !== fields.length) {
    throw invalid('Field names must be unique');
  }

  const defaultOperator: unknown = options.defaultOperator ?? 'OR';
  if (defaultOperator !== 'AND' && defaultOperator !== 'OR') {
    throw invalid(`defaultOperator must be "AND" or "OR", got ${String(defaultOperator)}`);
  }
  const resolved: ResolvedIndexOptions = {
    fields,
    storeFields:
      options.storeFields === undefined
        ? [...names]
        : stringList('storeFields', options.storeFields),
    idField: options.idField === undefined ? 'id' : nonEmptyString('idField', options.idField),
    k1,
    b,
    defaultOperator,
  };
  if (options.vectorField !== undefined) {
    resolved.vectorField = nonEmptyString('vectorField', options.vectorField);
  }
  return resolved;
}
