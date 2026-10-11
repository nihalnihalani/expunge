import type { WorkspaceStore } from '../workspace.js';

/**
 * runtime-scope.ts admits only agent ids that are workspace Dots, so the projection agent
 * lives behind one dedicated Dot. The marker (not the user-editable name) identifies it.
 * Editing the Dot's text has no authority effect; losing the marker only turns it into an
 * ordinary Dot, and a fresh Expunge Dot is created at the next start.
 */
export const EXPUNGE_DOT_MARKER = '[expunge-projection:v1]';

export function isExpungeDot(dot: { instructions: string }) {
  return dot.instructions.includes(EXPUNGE_DOT_MARKER);
}

export function ensureExpungeDot(workspace: WorkspaceStore) {
  if (workspace.dots().some(isExpungeDot)) return;
  const space = workspace.spaces()[0];
  if (!space) return;
  workspace.createDot(
    space.id,
    'Expunge status',
    `Reports what the database has committed about a cleanup job. It cannot start, change or approve anything. ${EXPUNGE_DOT_MARKER}`,
    false,
    false,
  );
}
