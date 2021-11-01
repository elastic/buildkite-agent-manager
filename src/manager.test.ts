import { GcpAgentConfiguration } from './agentConfig';
import { Agent } from './buildkite';
import { getStaleAgents, ManagerContext } from './manager';

let context: ManagerContext;

const addGcpAgentConfig = (
  context: ManagerContext,
  agentConfig: Partial<GcpAgentConfiguration>,
  buildkiteAgents: Partial<Agent>[] = []
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
};

describe('Manager', () => {
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
  });
});
