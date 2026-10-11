import { defineTool } from '@expunge/vendor-openmuse';
import type { ToolProvider } from '@expunge/runtime';
import type { DomainEnv } from './env.js';
import { JobGateway, TOOL_SPECS } from './gateway.js';

/**
 * The nine typed, job-bound worker tools as a `ToolProvider` for the runtime. For each run the runtime hands over the
 * stored job, the pinned bundle and the lease; the provider opens a gateway on them (the world capability comes from
 * the stored job row) and offers every tool as a definition whose `execute` goes through the gateway's decision
 * pipeline. The runtime shows the model only the tools the pinned bundle grants.
 *
 * A bundle that names an owner floor this process does not know cannot run: `create` rejects, and the runtime
 * reports the tools as unavailable instead of falling back to some other floor.
 */
export function createDomainToolProvider(env: DomainEnv): ToolProvider {
  return {
    async create(context) {
      const gateway = await JobGateway.open(env, context);
      return TOOL_SPECS.map((spec) =>
        defineTool({
          name: spec.toolId,
          description: spec.description,
          parameters: spec.parameters as never,
          execute: async (args: unknown) => (await gateway.call(spec.toolId, args)) as never,
        }),
      );
    },
  };
}
