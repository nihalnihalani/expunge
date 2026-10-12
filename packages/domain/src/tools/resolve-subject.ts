import { z } from 'zod';
import { addressId } from '@expunge/mongo';
import type { DomainAddress } from '@expunge/contracts';
import { computeClosure } from '../closure.js';
import { maskSubject } from '../keys.js';
import type { ToolRuntime } from '../runtime.js';
import { ToolRefusal } from '../runtime.js';
import { scalarsAt } from '../values.js';
import { idBinding } from './preview-cleanup.js';

/** No arguments: the subject is the one the owner submitted with the job, read from the stored row. */
export const resolveSubjectInput = z.object({}).strict();

/** The terminal reason of a job whose submitted subject matches no record in the world. */
export const SUBJECT_NOT_FOUND = 'SubjectNotFound';

export async function resolveSubject(rt: ToolRuntime) {
  const registry = await rt.registry();
  const policy = await rt.ownerPolicy();
  const subject = await rt.store.getSubject(rt.actor, rt.job._id);
  const rootAddress: DomainAddress = {
    collectionId: policy.subjectCollectionId,
    recordId: subject.idType === 'int' ? Number(subject.value) : subject.value,
    recordIdBsonType: subject.idType,
  };
  try {
    addressId(rootAddress);
  } catch {
    throw new ToolRefusal('InvalidSubjectIdentifier');
  }
  const root = await rt.env.scopes.readRecord(rt.world, registry, rootAddress);
  const worldRevision = await rt.worldRevision();
  const display = {
    display: maskSubject(subject.value),
    identityHash: subject.identityHash,
    idType: subject.idType,
  };
  // An explicit no-match: the gateway ends the job with this reason (nothing else can run without a resolution).
  if (!root)
    return {
      resolved: false as const,
      matched: false as const,
      reason: SUBJECT_NOT_FOUND,
      subject: display,
      worldRevision,
    };

  const roles = await rt.fieldRoles();
  const { fields } = await rt.visible();
  const visibleIds = new Set(fields.map((field) => field.fieldId));
  const bindings = new Set<string>();
  const identityBindings = new Set<string>();
  const fromFieldIds: string[] = [];
  // The record key is always visible and identifies the subject exactly.
  const rootKey = idBinding(rootAddress);
  if (rootKey !== null) {
    bindings.add(rootKey);
    identityBindings.add(rootKey);
  }
  for (const field of registry.fields) {
    if (field.collectionId !== rootAddress.collectionId || roles.get(field.fieldId) !== 'identity') continue;
    const values = scalarsAt(root, field);
    if (values.length === 0) continue;
    for (const { key } of values) identityBindings.add(key);
    if (!visibleIds.has(field.fieldId)) continue;
    fromFieldIds.push(field.fieldId);
    for (const { key } of values) bindings.add(key);
  }
  if (bindings.size === 0) throw new ToolRefusal('SubjectHasNoExactIdentity');
  const resolution = {
    root: { address: rootAddress, rev: root._rev },
    bindings: [...bindings].sort(),
    fromFieldIds: fromFieldIds.sort(),
    identityBindings: [...identityBindings].sort(),
  };
  const closure = await computeClosure(rt, resolution);
  await rt.store.appendStep(
    rt.actor,
    rt.run,
    'subject_resolution',
    { ...resolution, closure: closure.members, closureTruncated: closure.truncated },
    worldRevision,
  );
  return {
    resolved: true as const,
    matched: true as const,
    subject: display,
    rootCollectionId: rootAddress.collectionId,
    bindingCount: bindings.size,
    fromFieldIds: fromFieldIds.sort(),
    worldRevision,
  };
}
