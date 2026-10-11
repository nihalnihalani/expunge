import { buildW0Bundle } from '@expunge/baselines';
import { COMPILER_HASH, VOCABULARY_HASH } from '@expunge/harness-compiler';
import type { HarnessBundle } from '@expunge/contracts';
import { ELIGIBILITY_POLICY_HASH } from '@expunge/fixtures';
import { ArtifactRepository, type MongoService } from '@expunge/mongo';
import { HASH, actor, openEnvironment, type LiveEnvironment } from '../../mongo/test/support.js';

export const infra = {
  runtimeAdapterHash: 'c'.repeat(64),
  compilerHash: COMPILER_HASH,
  vocabularyHash: VOCABULARY_HASH,
  // installAuthority in the mongo test support installs the scope's floor as HASH.
  authorityFloorHash: HASH,
  eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
  sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
};
export const parentBundle = (): HarnessBundle => buildW0Bundle(infra);
let n = 0;
/** A behavioural child of the parent; each call has its own executable projection. */
export const childBundle = (parentHash: string, over: Partial<HarnessBundle> = {}): HarnessBundle => {
  const parent = parentBundle();
  return {
    ...parent,
    parentHash,
    contextPolicy: { ...parent.contextPolicy, maxContextTokens: 1000 + ++n },
    ...over,
  };
};
export const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };

export type Rig = {
  env: LiveEnvironment;
  grader: MongoService;
  builder: MongoService;
  promoter: MongoService;
  issuer: MongoService;
  parentHash: string;
  parent: HarnessBundle;
  insert(bundle: HarnessBundle): Promise<string>;
};
export async function openRig(label: string): Promise<Rig> {
  const env = await openEnvironment(label);
  const builder = await env.as('fixture_builder');
  const parent = parentBundle();
  const parentHash = (await new ArtifactRepository(builder).insert(parent))._id;
  return {
    env,
    grader: await env.as('grader'),
    builder,
    promoter: await env.as('promoter'),
    issuer: await env.as('approval_issuer'),
    parentHash,
    parent,
    insert: async (bundle) => (await new ArtifactRepository(builder).insert(bundle))._id,
  };
}
