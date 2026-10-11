import { describe, it, expect } from 'vitest';
import {
  isFieldPath,
  isRegistryFieldPath,
  parseFieldPath,
  RESERVED_ENVELOPE_FIELDS,
  PROJECTION_EVENT_KINDS,
  isProjectionEventKind,
  validateProjectionPayload,
  assertCanonicalJson,
  canonicalJson,
  contentHash,
  scopeIdentity,
  deploymentIdentity,
  validateHarnessBundle,
} from '../src/index.js';
import { validBundle } from './valid-bundle.js';
import { PROJECTION_SAMPLES } from './projection-samples.js';

export { validBundle };

describe('canonical structural authority', () => {
  it('matches RFC8785 number and property ordering vector', () => {
    // RFC 8785 test vector: the literal below is deliberately longer than a double can hold.
    // eslint-disable-next-line no-loss-of-precision
    expect(canonicalJson({ numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27], z: 1, a: 2 })).toBe(
      '{"a":2,"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"z":1}',
    );
    expect(contentHash({ b: 2, a: 1 })).toBe(contentHash({ a: 1, b: 2 }));
  });
  it('rejects implicit BSON/date/undefined/NaN serialization and lone surrogates', () => {
    for (const value of [
      new Date(),
      { a: undefined },
      NaN,
      Infinity,
      // A hole in an array is the case under test.
      // eslint-disable-next-line no-sparse-arrays
      [, 1],
      {
        toJSON() {
          return 'hidden';
        },
      },
      '\uD800',
    ])
      expect(() => assertCanonicalJson(value)).toThrow();
  });
  it('binds target and tenant/environment in deployment identities', () => {
    const key = { tenantId: 'a', env: 'demo' as const, scopeId: 'same' };
    expect(scopeIdentity(key)).not.toBe(scopeIdentity({ ...key, tenantId: 'b' }));
    expect(deploymentIdentity({ ...key, target: 'worker' })).not.toBe(
      deploymentIdentity({ ...key, target: 'improver' }),
    );
  });
  it('hashes plugin source+compiled hashes and semantic compiler identity', () => {
    const b = validBundle();
    const h = contentHash(b);
    expect(contentHash({ ...b, compilerHash: 'b'.repeat(64) })).not.toBe(h);
    expect(
      contentHash({
        ...b,
        pluginArtifacts: [
          {
            slot: 'critic',
            sourceHash: 'b'.repeat(64),
            compiledHash: 'c'.repeat(64),
            abiHash: 'd'.repeat(64),
            sandboxProfileHash: 'e'.repeat(64),
            exportName: 'critic',
            inputSchemaHash: 'f'.repeat(64),
            outputSchemaHash: '0'.repeat(64),
          },
        ],
      }),
    ).not.toBe(h);
  });
  it('rejects subject constants, unknown fields and broken workflow references', () => {
    const b = validBundle();
    expect(() => validateHarnessBundle({ ...b, customer: 'literal' })).toThrow();
    expect(() =>
      validateHarnessBundle({
        ...b,
        guardrails: [
          {
            ruleId: 'r',
            predicate: {
              op: 'compare',
              comparator: 'eq',
              left: { kind: 'fact', factId: 'f' },
              right: { kind: 'constant', value: 'Alice@example.com' },
            },
            result: 'allow',
            sourceEvidenceIds: [],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      validateHarnessBundle({ ...b, workflow: { ...b.workflow, entryNodeId: 'missing' } }),
    ).toThrow('InvalidWorkflowReferences');
  });
});

describe('field path grammar (frozen interface 2)', () => {
  const sparse: string[] = [];
  sparse[1] = 'b';

  it('accepts identifiers, one non-leading wildcard and up to 16 segments', () => {
    const accepted: string[][] = [
      ['data'],
      ['data', 'identity', 'id'],
      ['data', 'participants', '*', 'subject'],
      ['data', 'aliases', '*'],
      ['a_1', 'B2'],
      ['x'.repeat(32)],
      Array.from({ length: 16 }, (_, index) => `s${index}`),
      [...Array.from({ length: 14 }, (_, index) => `s${index}`), '*', 'tail'],
    ];
    for (const path of accepted) expect(isFieldPath(path), path.join('.')).toBe(true);
  });

  it('rejects leading wildcards, repeated wildcards, bad segments and wrong shapes', () => {
    const rejected: unknown[] = [
      [],
      ['*'],
      ['*', 'a'],
      ['a', '*', '*'],
      ['a', '*', 'b', '*'],
      ['x'.repeat(33)],
      ['1a'],
      ['_id'],
      ['_private'],
      ['a-b'],
      ['a.b'],
      ['a', ''],
      ['a', '$where'],
      ['a', '**'],
      ['a', 'b\n'],
      [' a'],
      Array.from({ length: 17 }, (_, index) => `s${index}`),
      ['a', 1],
      ['a', null],
      ['a', undefined],
      sparse,
      'a.b',
      null,
      undefined,
      { 0: 'a', length: 1 },
    ];
    for (const path of rejected) expect(isFieldPath(path), JSON.stringify(path)).toBe(false);
  });

  it('decomposes a path into segments and the wildcard position', () => {
    expect(parseFieldPath(['data', 'participants', '*', 'subject'])).toEqual({
      segments: ['data', 'participants', '*', 'subject'],
      wildcardIndex: 2,
    });
    expect(parseFieldPath(['data', 'identity']).wildcardIndex).toBeNull();
    const input = ['a', '*'];
    const parsed = parseFieldPath(input);
    parsed.segments.push('mutated');
    expect(input).toEqual(['a', '*']);
    for (const bad of [['*', 'a'], ['a', '*', '*'], [], ['_id']]) {
      expect(() => parseFieldPath(bad)).toThrow('InvalidFieldPath');
    }
  });

  it('allows the record key only as a read-only registry descriptor, never as a grammar path', () => {
    expect(isFieldPath(['_id'])).toBe(false);
    expect(isRegistryFieldPath(['_id'])).toBe(true);
    expect(isRegistryFieldPath(['data', 'x'])).toBe(true);
    expect(isRegistryFieldPath(['data', 'participants', '*', 'subject'])).toBe(true);
    expect(isRegistryFieldPath(['_id', 'x'])).toBe(false);
    expect(isRegistryFieldPath(['data', '_id'])).toBe(false);
    expect(isRegistryFieldPath(['*'])).toBe(false);
  });

  it('confines registered fields to the data subtree so envelope fields can never be written', () => {
    for (const envelope of RESERVED_ENVELOPE_FIELDS.filter((name) => name !== '_id')) {
      expect(isRegistryFieldPath([envelope]), envelope).toBe(false);
      expect(isRegistryFieldPath([envelope, 'x']), envelope).toBe(false);
    }
    expect(isRegistryFieldPath(['data'])).toBe(false);
    expect(isRegistryFieldPath(['payload', 'x'])).toBe(false);
  });
});

describe('projection event kinds and strict payloads', () => {
  const additive = [
    'job_status_changed',
    'cancel_requested',
    'approval_resolved',
    'harness_rolled_back',
    'retraction_progress',
    'campaign_row_committed',
  ] as const;

  it('freezes the eleven original kinds and the six additive kinds', () => {
    expect(PROJECTION_EVENT_KINDS).toHaveLength(17);
    for (const kind of additive) expect(isProjectionEventKind(kind), kind).toBe(true);
    expect(isProjectionEventKind('job_deleted')).toBe(false);
    expect(isProjectionEventKind(undefined)).toBe(false);
  });

  it('accepts a valid payload for every kind', () => {
    for (const kind of PROJECTION_EVENT_KINDS)
      expect(() => validateProjectionPayload(kind, PROJECTION_SAMPLES[kind]), kind).not.toThrow();
  });

  it('rejects an extra property, an empty payload and a mistyped field for every kind', () => {
    for (const kind of PROJECTION_EVENT_KINDS) {
      const sample = PROJECTION_SAMPLES[kind] as unknown as Record<string, unknown>;
      expect(
        () => validateProjectionPayload(kind, { ...sample, rawSubject: 'Alice' }),
        `${kind} extra`,
      ).toThrow(`InvalidProjectionPayload:${kind}`);
      expect(() => validateProjectionPayload(kind, {}), `${kind} empty`).toThrow(
        `InvalidProjectionPayload:${kind}`,
      );
      const [firstKey] = Object.keys(sample);
      expect(
        () => validateProjectionPayload(kind, { ...sample, [firstKey!]: { nested: true } }),
        `${kind} typed`,
      ).toThrow(`InvalidProjectionPayload:${kind}`);
    }
  });

  it('bounds free text and arrays so a payload cannot smuggle prose or large dumps', () => {
    const tool = PROJECTION_SAMPLES.tool_decided;
    expect(() => validateProjectionPayload('tool_decided', { ...tool, summary: 'x'.repeat(201) })).toThrow();
    const effect = PROJECTION_SAMPLES.effect_committed;
    expect(() =>
      validateProjectionPayload('effect_committed', {
        ...effect,
        nodeIds: Array.from({ length: 101 }, (_, i) => `n${i}`),
      }),
    ).toThrow();
    expect(() =>
      validateProjectionPayload('job_failed', { ...PROJECTION_SAMPLES.job_failed, message: 'x'.repeat(501) }),
    ).toThrow();
    expect(() =>
      validateProjectionPayload('harness_promoted', {
        ...PROJECTION_SAMPLES.harness_promoted,
        toHash: 'not-a-hash',
      }),
    ).toThrow();
  });

  it('refuses an unknown kind', () => {
    expect(() => validateProjectionPayload('job_deleted' as never, {})).toThrow('InvalidProjectionKind');
  });
});

describe('guardrail appliesTo', () => {
  const rule = {
    ruleId: 'r',
    predicate: { op: 'receipt_valid' as const, bindingId: 'b' },
    result: 'deny' as const,
    sourceEvidenceIds: [],
  };
  it('is optional, bounded to 16 ids and keeps the rule record strict', () => {
    const bundle = validBundle();
    for (const appliesTo of [undefined, [], ['apply_cleanup_batch'], ['a', 'b']]) {
      const guardrails = [appliesTo === undefined ? rule : { ...rule, appliesTo }];
      expect(() => validateHarnessBundle({ ...bundle, guardrails }), JSON.stringify(appliesTo)).not.toThrow();
    }
    const tooMany = Array.from({ length: 17 }, (_, index) => `t${index}`);
    expect(() =>
      validateHarnessBundle({ ...bundle, guardrails: [{ ...rule, appliesTo: tooMany }] }),
    ).toThrow();
    expect(() => validateHarnessBundle({ ...bundle, guardrails: [{ ...rule, appliesTo: [1] }] })).toThrow();
    expect(() => validateHarnessBundle({ ...bundle, guardrails: [{ ...rule, scope: 'x' }] })).toThrow();
  });
  it('changes the artifact hash, since it changes what the rule does', () => {
    const bundle = validBundle();
    expect(
      contentHash({ ...bundle, guardrails: [{ ...rule, appliesTo: ['apply_cleanup_batch'] }] }),
    ).not.toBe(contentHash({ ...bundle, guardrails: [rule] }));
  });
});
