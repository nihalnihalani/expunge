import { contentHash } from '@expunge/contracts';
import { sourceCommitment } from './source.js';
import { VOCABULARY_HASH } from './vocabulary.js';

export { VOCABULARY_HASH };
/**
 * The compiler's identity: the bytes of every module that decides what a bundle means, the contracts module that
 * defines hashing and validation, and the vocabulary hash. A bundle records it in `compilerHash`; a candidate built
 * for another compiler is refused.
 */
export const COMPILER_HASH = contentHash(
  {
    sources: sourceCommitment(
      [
        'classify.ts',
        'compile.ts',
        'decisions.ts',
        'guardrails.ts',
        'hashes.ts',
        'issues.ts',
        'literals.ts',
        'mongo-eval.ts',
        'mongo.ts',
        'noop.ts',
        'patches.ts',
        'plugins.ts',
        'policy.ts',
        'semantics.ts',
        'source.ts',
        'vocabulary.ts',
        'workflow.ts',
        '../../contracts/src/index.ts',
      ],
      'harness-compiler-source',
    ),
    vocabularyHash: VOCABULARY_HASH,
  },
  'harness-compiler',
);
