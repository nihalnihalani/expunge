import { databaseNamesFromEnv, dryRunReport, manualChecklist, planAtlasRoles } from './atlas-roles-plan.js';

/**
 * Prints what applying `atlasRoleManifests()` to Atlas would create, and the manual UI checklist. Makes no network call and
 * reads no secret value: it reports only whether ATLAS_CLIENT_ID, ATLAS_CLIENT_SECRET, ATLAS_PROJECT_ID and the per-principal
 * ATLAS_USER_PASSWORD_<PRINCIPAL> variables are SET. `--checklist` prints the Atlas UI steps instead of the JSON report.
 */
try {
  const plan = planAtlasRoles(databaseNamesFromEnv(process.env));
  if (process.argv.includes('--checklist')) console.log(manualChecklist(plan));
  else console.log(JSON.stringify(dryRunReport(plan), null, 2));
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof Error ? error.message : 'DryRunFailed' }));
  process.exitCode = 2;
}
