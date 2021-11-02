import { Agent } from '../buildkite';
import { GcpInstance } from '../gcp';
import { AgentConfigToCreate, ManagerContext } from './manager';

export interface ExecutionPlan {
  agentsToStop?: any[];
  gcp?: {
    instancesToDelete?: GcpInstance[];
    agentConfigsToCreate?: AgentConfigToCreate[];
  };
}

export function isGcpInstanceDisconnectedFromBuildkite(context: ManagerContext, instance: GcpInstance) {
  const now = new Date().getTime();
  const created = new Date(instance.metadata.creationTimestamp).getTime();

  if (now - created < 10 * 60 * 1000) {
    return false;
  }

  // Agent is at least 10 minutes old, and isn't connected to Buildkite anymore. Consider it gone.
  return !context.buildkiteAgents.find((a) => instance.metadata.name === a.name);
}

export function getAgentConfigsToCreate(context: ManagerContext) {
  const toCreate: AgentConfigToCreate[] = [];
  const agents = context.config.gcp.agents;

  for (const agent of agents) {
    const queue = context.buildkiteQueues[agent.queue];
    const jobs = queue ? queue.jobs.running + queue.jobs.scheduled : 0;

    const instances = context.gcpInstances.filter(
      (f) =>
        ['PROVISIONING', 'STAGING', 'RUNNING'].includes(f.metadata.status) &&
        f.metadata.metadata.items.find((i) => i.key === 'buildkite-agent-name' && i.value === agent.name) &&
        !isGcpInstanceDisconnectedFromBuildkite(context, f)
    );
    const currentAgents = Math.max(instances.length, queue.agents.total);

    let agentsNeeded = jobs;
    if (agent.minimumAgents) {
      agentsNeeded = Math.max(agentsNeeded, agent.minimumAgents);
    }

    if (agent.overprovision) {
      // overprovision < 1 is a percentage amount, >= 1 is a discrete amount
      const overprovisionAmount = agent.overprovision < 1 ? Math.ceil(agentsNeeded * agent.overprovision) : agent.overprovision;
      agentsNeeded = agentsNeeded + overprovisionAmount;
    }

    if (agent.maximumAgents) {
      agentsNeeded = Math.min(agentsNeeded, agent.maximumAgents);
    }

    const numberToCreate = agentsNeeded - currentAgents;
    if (numberToCreate > 0) {
      toCreate.push({
        config: agent,
        numberToCreate: numberToCreate,
        jobs: jobs,
        totalAgentsDesired: agentsNeeded,
        currentAgents: currentAgents,
      });
    }
  }

  return toCreate;
}

export function getStoppedInstances(context: ManagerContext) {
  const instances = context.gcpInstances.filter((i) => i.metadata.status === 'TERMINATED');
  return instances;
}

// Agents that should be gracefully stopped by sending a stop command to the Buildkite API
export function getStaleAgents(context: ManagerContext) {
  const agents = new Set<Agent>();
  for (const agentConfig of context.config.gcp.agents) {
    const hash = agentConfig.hash();

    const agentsForConfig = context.buildkiteAgents
      .filter((agent) => agent.connection_state === 'connected')
      .filter((agent) => agent.meta_data?.includes(`queue=${agentConfig.queue}`));

    // Agents with stale configs
    agentsForConfig.filter((agent) => !agent.meta_data?.includes(`hash=${hash}`)).forEach((agent) => agents.add(agent));

    // Agents that have been online for too long
    if (agentConfig.gracefulStopAfterMins) {
      agentsForConfig
        .filter((agent) => {
          const start = new Date(agent.created_at).getTime();
          const now = new Date().getTime();

          return now - start >= agentConfig.gracefulStopAfterMins * 60 * 1000;
        })
        .forEach((agent) => agents.add(agent));
    }
  }

  return [...agents];
}

export function createPlan(context: ManagerContext) {
  const plan: ExecutionPlan = {
    gcp: {
      instancesToDelete: getStoppedInstances(context), // deleted instances and instances past the hard-stop limit
      agentConfigsToCreate: getAgentConfigsToCreate(context),
    },
    agentsToStop: getStaleAgents(context), // agents attached to outdated configs, or ones that have reached their configed soft time limit
    // also, if there are too many agents of a given type, order than by name or creation and soft stop the extras
  };

  return plan;
}
