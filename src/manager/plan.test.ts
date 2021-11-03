import { GcpAgentConfiguration } from '../agentConfig';
import { Agent } from '../buildkite';
import { GcpInstance } from '../gcp';
import { ManagerContext } from './manager';
import { getAgentConfigsToCreate, getInstancesToDelete, getStaleAgents } from './plan';

let context: ManagerContext;

const addGcpAgentConfig = (
  context: ManagerContext,
  agentConfig: Partial<GcpAgentConfiguration>,
  buildkiteAgents: Partial<Agent>[] = [],
  gcpInstances: Partial<GcpInstance['metadata']>[] = []
) => {
  const config = new GcpAgentConfiguration({
    name: 'test-name',
    queue: 'queue',
    project: 'test-project',
    imageFamily: 'test-image-family',
    machineType: 'test-machine-type',
    zone: 'test-zone',
    ...agentConfig,
  });

  context.config.gcp.agents.push(config);
  context.buildkiteQueues[config.queue] = {
    agents: {
      idle: 0,
      busy: 0,
      total: 0,
    },
    jobs: {
      running: 0,
      scheduled: 0,
      total: 0,
      waiting: 0,
    },
    organization: {
      slug: 'org',
    },
  };

  for (const buildkiteAgent of buildkiteAgents) {
    const fullAgent: Agent = {
      id: 'test-id',
      connection_state: 'connected',
      created_at: new Date().toISOString(),
      creator: 'creator',
      hostname: 'agent-hostname',
      ip_address: '127.0.0.1',
      last_job_finished_at: '',
      meta_data: [],
      name: 'test-name',
      priority: 0,
      url: 'http://url',
      web_url: 'http://web_url',
      user_agent: 'user-agent',
      version: '1.0.0',
      ...buildkiteAgent,
    };

    fullAgent.meta_data.push(`queue=${config.queue}`);
    fullAgent.meta_data.push(`hash=${config.hash()}`);

    context.buildkiteAgents.push(fullAgent);
  }

  for (const gcpInstance of gcpInstances) {
    const instance: GcpInstance = {
      metadata: {
        id: 'machine-id',
        creationTimestamp: new Date().toISOString(),
        name: 'test-name',
        status: 'RUNNING',
        zone: 'zone',
        labels: {},
        machineType: 'machine-type',
        metadata: {
          items: [
            {
              key: 'buildkite-agent-name',
              value: config.name,
            },
          ],
        },
        ...gcpInstance,
      },
    };
    context.gcpInstances.push(instance);
  }
};

describe('Plan', () => {
  beforeEach(() => {
    context = {
      buildkiteAgents: [],
      buildkiteQueues: {},
      gcpInstances: [],
      config: {
        gcp: {
          project: 'test-project',
          agents: [],
        },
      },
    };
  });

  describe('getStaleAgents', () => {
    it('should return no stale agents when there are none', () => {
      addGcpAgentConfig(
        context,
        {
          gracefulStopAfterMins: 10,
        },
        [
          {
            created_at: new Date().toISOString(),
          },
          {
            created_at: new Date().toISOString(),
          },
        ]
      );

      const agents = getStaleAgents(context);
      expect(agents).toEqual([]);
    });

    it('should return no stale agents when there are some that have been online for too long', () => {
      addGcpAgentConfig(
        context,
        {
          gracefulStopAfterMins: 10,
        },
        [
          {
            id: 'stale-id-1',
            created_at: new Date('2000-01-01T00:00:00').toISOString(),
          },
          {
            created_at: new Date().toISOString(),
          },
          {
            id: 'stale-id-2',
            created_at: new Date('2000-01-01T00:00:00').toISOString(),
          },
          {
            created_at: new Date().toISOString(),
          },
        ]
      );

      const agents = getStaleAgents(context);
      expect(agents.length).toEqual(2);
      expect(agents[0].id).toEqual('stale-id-1');
      expect(agents[1].id).toEqual('stale-id-2');
    });

    it('should return no stale agents when there are some with outdated hashes', () => {
      addGcpAgentConfig(
        context,
        {
          gracefulStopAfterMins: 10,
        },
        [{ id: 'hash-id' }, {}, {}]
      );

      context.buildkiteAgents[0].meta_data = ['queue=queue', 'hash=out-of-date'];

      const agents = getStaleAgents(context);
      expect(agents.length).toEqual(1);
      expect(agents[0].id).toEqual('hash-id');
    });

    it('should return stale agents one time when agents match multiple stale criteria', () => {
      addGcpAgentConfig(
        context,
        {
          gracefulStopAfterMins: 10,
        },
        [{ id: 'stale-id', created_at: new Date('2000-01-01T00:00:00').toISOString() }, {}, {}]
      );

      context.buildkiteAgents[0].meta_data = ['queue=queue', 'hash=out-of-date'];

      const agents = getStaleAgents(context);
      expect(agents.length).toEqual(1);
      expect(agents[0].id).toEqual('stale-id');
    });
  });

  describe('getInstancesToDelete', () => {
    it('should return no instances when there are none to delete', () => {
      addGcpAgentConfig(context, {}, [{}, {}], [{}, {}]);

      const instances = getInstancesToDelete(context);
      expect(instances).toEqual([]);
    });

    it('should return instances when there are some older than the hard timeout', () => {
      addGcpAgentConfig(
        context,
        {
          hardStopAfterMins: 5,
        },
        [{}, {}],
        [
          {
            creationTimestamp: new Date().toISOString(),
          },
          {
            id: 'old-id',
            creationTimestamp: new Date(new Date().getTime() - 7 * 60000).toISOString(),
          },
        ]
      );

      const instances = getInstancesToDelete(context);
      expect(instances.length).toEqual(1);
      expect(instances[0].metadata.id).toEqual('old-id');
    });

    it('should return instances when there are stopped ones', () => {
      addGcpAgentConfig(
        context,
        {},
        [{}, {}],
        [
          {},
          {
            id: 'stopped-1',
            status: 'TERMINATED',
          },
          {
            id: 'stopped-2',
            status: 'TERMINATED',
          },
        ]
      );

      const instances = getInstancesToDelete(context);
      expect(instances.length).toEqual(2);
      expect(instances[0].metadata.id).toEqual('stopped-1');
      expect(instances[1].metadata.id).toEqual('stopped-2');
    });

    it('should return instances when there are some older 10 minutes and not in buildkite', () => {
      addGcpAgentConfig(
        context,
        {},
        [{}, {}],
        [
          {
            id: 'old-id',
            name: 'dne',
            creationTimestamp: new Date(new Date().getTime() - 11 * 60000).toISOString(),
          },
          {
            creationTimestamp: new Date(new Date().getTime() - 11 * 60000).toISOString(),
          },
        ]
      );

      const instances = getInstancesToDelete(context);
      expect(instances.length).toEqual(1);
      expect(instances[0].metadata.id).toEqual('old-id');
    });
  });

  describe('getAgentConfigsToCreate', () => {
    it('should create agents when none are running and a minimum is present', () => {
      addGcpAgentConfig(context, {
        minimumAgents: 10,
      });

      const configs = getAgentConfigsToCreate(context);
      expect(configs.length).toEqual(1);
      expect(configs[0].numberToCreate).toEqual(10);
    });

    it('should create agents when some are needed to fulfill requests', () => {
      addGcpAgentConfig(context, {});
      context.buildkiteQueues[context.config.gcp.agents[0].queue].jobs.waiting = 100;
      context.buildkiteQueues[context.config.gcp.agents[0].queue].jobs.scheduled = 100;
      context.buildkiteQueues[context.config.gcp.agents[0].queue].jobs.total = 200;

      const configs = getAgentConfigsToCreate(context);
      expect(configs.length).toEqual(1);
      expect(configs[0].numberToCreate).toEqual(100);
    });

    it('should not create more than the maximum number of agents', () => {
      addGcpAgentConfig(context, { maximumAgents: 10 });
      context.buildkiteQueues[context.config.gcp.agents[0].queue].jobs.waiting = 100;
      context.buildkiteQueues[context.config.gcp.agents[0].queue].jobs.scheduled = 100;
      context.buildkiteQueues[context.config.gcp.agents[0].queue].jobs.total = 200;

      const configs = getAgentConfigsToCreate(context);
      expect(configs.length).toEqual(1);
      expect(configs[0].numberToCreate).toEqual(10);
    });

    it('should not create more agents if some are spinning up or running', () => {
      addGcpAgentConfig(context, {}, [], [{ status: 'PROVISIONING' }, { status: 'RUNNING' }, { status: 'TERMINATED' }]);

      context.buildkiteQueues[context.config.gcp.agents[0].queue].jobs.scheduled = 5;
      context.buildkiteQueues[context.config.gcp.agents[0].queue].jobs.total = 5;

      const configs = getAgentConfigsToCreate(context);
      expect(configs.length).toEqual(1);
      expect(configs[0].numberToCreate).toEqual(3);
    });

    it('should not consider old instances that are not connected to buildkite as currently running', () => {
      addGcpAgentConfig(context, {}, [], [{ creationTimestamp: new Date(new Date().getTime() - 60 * 60000).toISOString() }]);

      context.buildkiteQueues[context.config.gcp.agents[0].queue].jobs.scheduled = 5;
      context.buildkiteQueues[context.config.gcp.agents[0].queue].jobs.total = 5;

      const configs = getAgentConfigsToCreate(context);
      expect(configs.length).toEqual(1);
      expect(configs[0].numberToCreate).toEqual(5);
    });
  });
});
