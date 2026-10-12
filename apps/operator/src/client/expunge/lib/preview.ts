import {
  sourceBindingsEqual,
  type CleanupPreview,
  type WorldSummary,
} from '../../../shared/expunge';

/** Pure binding/expiry check. An unbound preview never becomes current through matching counters. */
export function previewStale(
  preview: Pick<
    CleanupPreview,
    'worldId' | 'expiresAt' | 'worldRevision' | 'scopeRevision' | 'source'
  >,
  world:
    | Pick<
        WorldSummary,
        | 'worldId'
        | 'maintenanceMode'
        | 'worldRevision'
        | 'scopeRevision'
        | 'source'
      >
    | undefined,
  now: number,
): string | null {
  if (now >= Date.parse(preview.expiresAt)) return 'This preview has expired.';
  if (!world) return 'The world is no longer listed.';
  if (world.worldId !== preview.worldId)
    return 'The preview belongs to a different source scope.';
  if (world.maintenanceMode) return 'The world is in maintenance mode.';
  if (!sourceBindingsEqual(preview.source, world.source))
    return 'The preview is not bound to the current registered source, policy and cleanup permission. Preview again after setup.';
  if (
    world.worldRevision !== preview.worldRevision ||
    world.scopeRevision !== preview.scopeRevision
  )
    return 'The world changed since this preview.';
  return null;
}

/** Shown instead of Submit when the model-free preview matched nothing: a job could only end SubjectNotFound. */
export const NO_MATCH_MESSAGE =
  'No record in this world matches this identifier. Check the identifier type and value.';

/** True when no collection holds a record with the subject's exact identity. */
export function previewHasNoMatch(
  preview: Pick<CleanupPreview, 'perCollection'>,
): boolean {
  return preview.perCollection.every((row) => row.exactIdentityMatches === 0);
}
