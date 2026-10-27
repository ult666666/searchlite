import { SearchIndex, evaluate } from '../../src/index';
import {
  createLocalReviewer,
  LocalReviewError,
  serializeLocalReport,
} from '../../examples/local-review-core.js';
import type { LocalInputs, LocalReply, LocalRequest } from './local-types';
const channel = self as unknown as Pick<Worker, 'onmessage' | 'postMessage'>;
const reviewer = createLocalReviewer({
  SearchIndex,
  evaluate,
  digest: async (bytes) => {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  },
});
function synthetic(changed: boolean): LocalInputs {
  const documents = [
    { id: 'a.md', title: 'quartz', body: 'other' },
    { id: 'b.md', title: 'other', body: 'quartz' },
  ];
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n');
  const snapshot = (candidate: boolean) => {
    const index = new SearchIndex({
      fields: candidate ? { title: {}, body: { boost: 3 } } : { title: { boost: 3 }, body: {} },
    });
    index.addAll(documents);
    return encode(index.toJSON());
  };
  return {
    baseline: snapshot(false),
    candidate: snapshot(changed),
    judgments: encode({
      schema: 'searchlite.local-judgments/1',
      queries: [
        {
          id: 'title-task',
          text: 'quartz',
          minimumNdcgAt10: 0.5,
          relevance: [{ documentId: 'a.md', grade: 3 }],
        },
        {
          id: 'body-task',
          text: 'quartz',
          minimumNdcgAt10: 0.5,
          relevance: [{ documentId: 'b.md', grade: 3 }],
        },
      ],
    }),
  };
}
async function review(request: LocalRequest): Promise<void> {
  try {
    const inputs = request.kind === 'example' ? synthetic(request.changed) : request.inputs;
    const report = await reviewer.compare(
      reviewer.restore(inputs.baseline),
      reviewer.restore(inputs.candidate),
      inputs.judgments,
    );
    const reply: LocalReply = {
      kind: 'report',
      text: serializeLocalReport(report),
      ...(request.kind === 'example' ? { inputs } : {}),
    };
    channel.postMessage(reply);
  } catch (error) {
    const reply: LocalReply =
      error instanceof LocalReviewError
        ? { kind: 'error', code: error.code, message: error.message }
        : {
            kind: 'error',
            code: 'OPERATION_FAILED',
            message: 'The local comparison could not be completed.',
          };
    channel.postMessage(reply);
  }
}
channel.onmessage = (event: MessageEvent<LocalRequest>) => {
  void review(event.data);
};
