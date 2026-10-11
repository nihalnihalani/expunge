import { describe, expect, it, vi } from 'vitest';
import { contentHash } from '@expunge/contracts';
import { createWorldSpec } from '@expunge/fixtures';
import type { FixtureDocument } from '@expunge/fixtures';
import type { SealedFixture } from '@expunge/fixtures/sealed';

/**
 * TEST DOUBLE (labelled): the sealed generator is wrapped so that every TARGET record also carries an extra field.
 * The manifest is rebuilt consistently, so the reference solver still solves the world and only the shape canary can
 * object. This stands in for a hypothetical future generator regression; the real generator never does this.
 */
vi.mock('@expunge/fixtures/sealed', async (importOriginal) => {
  const original = await importOriginal<typeof import('@expunge/fixtures/sealed')>();
  return {
    ...original,
    generateSealedFixture: (...args: Parameters<typeof original.generateSealedFixture>): SealedFixture => {
      const fixture = original.generateSealedFixture(...args);
      const targets = new Set(fixture.manifest.effects.map((effect) => effect.address.recordId));
      const mark = (row: FixtureDocument) => {
        if (targets.has(row._id)) row.data.shapeTell = true;
      };
      Object.values(fixture.world.collections).forEach((rows) => rows.forEach(mark));
      Object.values(fixture.manifest.expectedState).forEach((rows) => rows.forEach(mark));
      const { manifestHash: _old, ...payload } = fixture.manifest;
      // Whole-record preservation hashes (restricted targets) cover the extra field too.
      for (const entry of payload.preservationHashes) {
        if (entry.path.join('.') !== 'data') continue;
        const row = fixture.world.collections[entry.address.collectionId].find(
          (r) => r._id === entry.address.recordId,
        )!;
        entry.hash = contentHash(row.data, 'fixture-preserved-value');
      }
      payload.expectedStateHash = contentHash(payload.expectedState, 'fixture-world-state');
      return {
        world: fixture.world,
        manifest: { ...payload, manifestHash: contentHash(payload, 'fixture-manifest') },
      };
    },
  };
});

import { admit } from './helpers.js';
import { publicAdmissionVerdict } from '../src/index.js';

describe('reference admission refuses a world whose targets are identifiable by shape', () => {
  it('quarantines with shape_leak and names the detectors that beat chance', () => {
    const seed = 'shape-tell';
    const admission = admit(createWorldSpec({ family: 'mixed_eligibility', seed }), seed);
    expect(admission.admitted).toBe(false);
    const verdict = publicAdmissionVerdict(admission);
    expect(verdict.reasonCodes[0]).toBe('shape_leak');
    expect(verdict.reasonCodes).toEqual(
      expect.arrayContaining([
        'shape_leak:structure_fingerprint_outlier',
        'shape_leak:format_fingerprint_outlier',
      ]),
    );
    expect(verdict.reasonCodes).not.toContain('reference_not_solvable');
    expect(verdict.referenceResultHash).toBeNull();
    expect(JSON.stringify(verdict)).not.toContain('shapeTell');
  });
});
