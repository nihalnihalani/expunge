import { contentHash, type DomainAddress } from '@expunge/contracts';
import { canonicalAddress, nodeKey } from '@expunge/mongo';

/** `collection/recordId`, with every spelling of the same `_id` mapping to one string. */
export function addressKey(address: DomainAddress): string {
  const canonical = canonicalAddress(address);
  return `${canonical.collectionId}/${canonical.recordIdBsonType}:${canonical.recordId}`;
}
export { nodeKey };

/** A short non-reversible display of a subject value: enough to recognize it, not to recover it. */
export function maskSubject(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}
export function identityHashOf(idType: string, value: string): string {
  return contentHash({ idType, value }, 'subject-identity');
}
