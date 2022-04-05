import { getConfig, GcpAgentConfiguration, AgentConfiguration } from '../agentConfig';
import { createInstance, deleteInstance, GcpInstance, getAllAgentInstances, getImageForFamily } from '../gcp';
import { Agent, AgentMetrics, Buildkite } from '../buildkite';
import logger from '../lib/logger';
import { createPlan, ExecutionPlan, printPlan } from './plan';
import { withPromisePool } from '../lib/withPromisePool';
import { getPreemptionsWithCache, getResourceExhaustionsWithCache, getZoneWeightingFromMetrics, MetricsResult } from '../spot';

let buildkite: Buildkite;

export interface ManagerContext {
  config: AgentConfiguration;
  buildkiteAgents: Agent[];
  buildkiteQueues: Record<string, AgentMetrics>;
  gcpInstances: GcpInstance[];
  preemptions?: MetricsResult;
  resourceExhaustions?: MetricsResult;
}

export interface AgentConfigToCreate {
  config: GcpAgentConfiguration;
  numberToCreate: number;

  // Below is really just for informational purposes
  jobs: number;
  totalAgentsDesired: number;
  currentAgents: number;
}

type Unwrap<T> = T extends PromiseLike<infer U> ? U : T;

function withTimeout<T>(timeoutSeconds: number, promise: Promise<T>): Promise<T> {
  const timeoutPromise = new Promise<T>((resolve, reject) => {
    setTimeout(reject, timeoutSeconds * 1000, 'Timeout exceeded');
  });

  return Promise.race([promise, timeoutPromise]);
}

export async function getAllQueues(configs: GcpAgentConfiguration[]) {
  const queueSet = new Set<string>();
  for (const config of configs) {
    queueSet.add(config.queue);
  }

  const queues = [...queueSet];
  const results = await Promise.all(queues.map((queue) => buildkite.getAgentMetrics(queue)));
  const queuesByKey = {} as Record<string, AgentMetrics>;
  for (const key in queues) {
    queuesByKey[queues[key]] = results[key];
  }

  return queuesByKey;
}

export async function getAllImages(projectId: string, configs: GcpAgentConfiguration[]) {
  const uniqueFamilies = [...new Set(configs.map((c) => c.imageFamily).filter((f) => f))];
  const families = {};
  for (const family of uniqueFamilies) {
    families[family] = (await getImageForFamily(projectId, family)).name;
  }

  return families as Record<string, string>;
}

export async function createInstances(context: ManagerContext, toCreate: AgentConfigToCreate) {
  logger.info(`[gcp] Creating ${toCreate.numberToCreate} instances of ${toCreate.config.queue}`);
  if (toCreate.config.spot) {
    const weighting = getZoneWeightingFromMetrics(toCreate.config.zones, context.preemptions, context.resourceExhaustions);
    const weightingString = Object.keys(weighting)
      .map((k) => `[${k}:${weighting[k]}]`)
      .join(', ');
    logger.info(`[gcp] With current weighting: ${weightingString}`);
  }

  try {
    await withPromisePool(25, new Array(toCreate.numberToCreate), async () => {
      await createInstance(toCreate.config, context.preemptions, context.resourceExhaustions);
      return true;
    });
  } finally {
    logger.info('[gcp] Done creating instances');
  }
}

export async function deleteInstances(instances: GcpInstance[]) {
  logger.info(`[gcp] Deleting ${instances.length} instances: ${instances.map((i) => i.metadata.name).join(', ')}`);

  try {
    await withPromisePool(10, instances, async (instance) => {
      await deleteInstance(instance);
      return true;
    });
  } finally {
    logger.info('[gcp] Done deleting instances');
  }
}

export async function stopAgents(agents: Agent[]) {
  logger.info(`[buildkite] Stopping ${agents.length} agents: ${agents.map((a) => a.name).join(', ')}`);

  try {
    await withPromisePool(5, agents, async (agent) => {
      await buildkite.stopAgent(agent);
      return true;
    });
  } finally {
    logger.info('[buildkite] Done stopping agents');
  }
}

export async function executePlan(context: ManagerContext, plan: ExecutionPlan) {
  const promises: Promise<any>[] = [];

  if (plan.gcp.agentConfigsToCreate?.length) {
    for (const config of plan.gcp.agentConfigsToCreate) {
      promises.push(createInstances(context, config));
    }
  }

  if (plan.gcp.instancesToDelete?.length) {
    promises.push(deleteInstances(plan.gcp.instancesToDelete));
  }

  if (plan.agentsToStop?.length) {
    promises.push(stopAgents(plan.agentsToStop));
  }

  await Promise.all(promises);
}

export async function run() {
  buildkite = buildkite || new Buildkite(); // TODO make this better
  const config = await getConfig();

  logger.info('[manager] Gathering data for current state');
  const promise = Promise.all([
    buildkite.getAgents(),
    getAllAgentInstances(config.gcp),
    getAllQueues(config.gcp.agents),
    getAllImages(config.gcp.project, config.gcp.agents),
    getPreemptionsWithCache(config.gcp.project),
    getResourceExhaustionsWithCache(config.gcp.project),
  ]);
  const [agents, instances, queues, imagesFromFamilies, preemptions, resourceExhaustions] = await withTimeout<Unwrap<typeof promise>>(
    60,
    promise
  );
  logger.info('[manager] Finished gathering data for current state');

  config.gcp.agents.forEach((agent) => {
    if (agent.imageFamily && !agent.image) {
      agent.image = imagesFromFamilies[agent.imageFamily];
    }
  });

  const context: ManagerContext = {
    config: config,
    buildkiteAgents: agents,
    gcpInstances: instances,
    buildkiteQueues: queues,
    preemptions: preemptions,
    resourceExhaustions: resourceExhaustions,
  };

  const plan = createPlan(context);

  if (process.env.DRY_RUN) {
    printPlan(plan);
    return;
  }

  await executePlan(context, plan);
}
