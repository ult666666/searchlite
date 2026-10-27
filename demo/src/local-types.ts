import type { ReviewBytes } from '../../examples/local-review-core.js';
export type LocalInputs = Record<'baseline' | 'candidate' | 'judgments', ReviewBytes>;
export type LocalRequest =
  { kind: 'compare'; inputs: LocalInputs } | { kind: 'example'; changed: boolean };
export type LocalReply =
  | { kind: 'report'; text: string; inputs?: LocalInputs }
  | { kind: 'error'; code: string; message: string };
