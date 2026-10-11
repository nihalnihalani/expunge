import type { PluginBinding } from '@expunge/contracts';
import { issue, type Issue } from './issues.js';

/** What the trusted artifact store can attest about one plugin binding. */
export interface PluginAttestation {
  sourceVerified: boolean;
  compiledVerified: boolean;
  /** The compiled artifact was produced from exactly this source by the trusted compile options. */
  compiledFromSource: boolean;
}
export interface PluginPolicy {
  abiHash: string;
  sandboxProfileHash: string;
  attest(binding: PluginBinding): PluginAttestation;
}

/** Both the source and the compiled hash must verify and pair, or one payload could be evaluated and another run. */
export function validatePlugins(
  bindings: readonly PluginBinding[],
  policy: PluginPolicy | undefined,
): Issue[] {
  const issues: Issue[] = [];
  const slots = new Set<string>();
  bindings.forEach((binding, index) => {
    const where = `pluginArtifacts[${index}]`;
    if (slots.has(binding.slot)) issues.push(issue('schema_invalid', where, 'one binding per slot'));
    slots.add(binding.slot);
    if (!policy) {
      issues.push(issue('plugin_unverifiable', where, 'no plugin policy is available to verify the binding'));
      return;
    }
    if (binding.abiHash !== policy.abiHash || binding.sandboxProfileHash !== policy.sandboxProfileHash) {
      issues.push(issue('plugin_abi_mismatch', where, 'ABI or sandbox profile is not the admitted one'));
    }
    const attestation = policy.attest(binding);
    if (!attestation.sourceVerified || !attestation.compiledVerified) {
      issues.push(issue('plugin_unverifiable', where, 'source or compiled hash does not verify'));
    } else if (!attestation.compiledFromSource) {
      issues.push(
        issue(
          'plugin_source_compiled_mismatch',
          where,
          'compiled artifact does not come from the pinned source',
        ),
      );
    }
  });
  return issues;
}
