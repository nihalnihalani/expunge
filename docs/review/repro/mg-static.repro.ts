// DA-1 repro (no database): address canonicalization, role-manifest over-privilege, unfiltered generated predicates.
// Exit 0 = every check reproduced, 1 = some did not, 2 = error.
// Run: npx tsx docs/review/repro/mg-static.repro.ts
import { ObjectId } from 'mongodb';
import { addressId, atlasRoleManifests, nodeKey, worldFilter } from '@expunge/mongo';

const out: Array<[string, boolean, string]> = [];
try {
  // S1: one int32 record has many accepted spellings -> distinct nodeKeys/target hashes for the same document.
  const spellings = ['16', '0x10', '1.6e1', ' 16 ', '016', '16.0'];
  const accepted = spellings.filter((s) => {
    try {
      return addressId({ collectionId: 'c', recordId: s, recordIdBsonType: 'int' }) === 16;
    } catch {
      return false;
    }
  });
  const keys = new Set(
    accepted.map((s) => nodeKey({ collectionId: 'c', recordId: s, recordIdBsonType: 'int' })),
  );
  const emptyIsZero = (() => {
    try {
      return addressId({ collectionId: 'c', recordId: '', recordIdBsonType: 'int' }) === 0;
    } catch {
      return false;
    }
  })();
  const hex = '507f1f77bcf86cd799439011';
  let upperAccepted = false;
  try {
    upperAccepted = (
      addressId({ collectionId: 'c', recordId: hex.toUpperCase(), recordIdBsonType: 'objectId' }) as ObjectId
    ).equals(new ObjectId(hex));
  } catch {
    // Rejected: a non-canonical ObjectId spelling is refused, so `upperAccepted` stays false.
  }
  const oidKeys =
    upperAccepted &&
    nodeKey({ collectionId: 'c', recordId: hex, recordIdBsonType: 'objectId' }) !==
      nodeKey({ collectionId: 'c', recordId: hex.toUpperCase(), recordIdBsonType: 'objectId' });
  out.push([
    'S1 non-canonical record-id spellings accepted',
    accepted.length > 1 || emptyIsZero || oidKeys,
    `int spellings for 16 accepted=${JSON.stringify(accepted)} -> ${keys.size} nodeKeys; ''->0 ${emptyIsZero}; upper-case ObjectId accepted with distinct nodeKey ${oidKeys}`,
  ]);

  // S2: collection-level privileges that let non-owners rewrite authority rows.
  const roles = atlasRoleManifests();
  const has = (p: string, verb: string, coll: string) =>
    !!roles[p as keyof typeof roles]?.actions.some(
      (a) => a.action === verb && a.resources.some((r) => r.collection === coll),
    );
  const jobsWriters = Object.keys(roles).filter((p) => has(p, 'UPDATE', 'jobs'));
  const facts = {
    executorRegistryInsert: has('domain_executor', 'INSERT', 'schema_registry'),
    executorRegistryUpdate: has('domain_executor', 'UPDATE', 'schema_registry'),
    executorWorldRevisionUpdate: has('domain_executor', 'UPDATE', 'world_revisions'),
    promoterApprovalsUpdate: has('promoter', 'UPDATE', 'approvals'),
    proposerCandidatesInsert: has('proposer', 'INSERT', 'candidates'),
    jobsWriters,
  };
  out.push([
    'S2 role manifest lets non-owners write authority rows',
    facts.executorRegistryInsert &&
      facts.executorRegistryUpdate &&
      facts.promoterApprovalsUpdate &&
      facts.proposerCandidatesInsert &&
      jobsWriters.length > 2,
    JSON.stringify(facts),
  ]);

  // S3: worldFilter passes any generated operator through, including server-side JavaScript.
  let f = '';
  try {
    f = JSON.stringify(
      worldFilter({ actorId: 'a', tenantId: 't', env: 'demo', scopeId: 's', authorizationRevision: 1 }, 'w', {
        $where: 'sleep(10000) || true',
      }),
    );
  } catch (error) {
    f = `rejected: ${(error as Error).message}`;
  }
  out.push(['S3 worldFilter forwards $where from the generated predicate', f.includes('$where'), f]);
} catch (error) {
  console.error('ERROR', error);
  process.exit(2);
}
for (const [id, ok, detail] of out)
  console.log(`${ok ? 'REPRODUCED' : 'NOT REPRODUCED'}  ${id} :: ${detail}`);
process.exit(out.every(([, ok]) => ok) ? 0 : 1);
