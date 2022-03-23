import { GcpAgentConfiguration } from './agentConfig';
import { getBuildkiteConfig } from './gcp';

const mockGcpAgentConfig = (props = {}) => {
  return new GcpAgentConfiguration({
    name: 'test',
    queue: 'test-queue',

    project: 'project',
    zones: ['zone-a', 'zone-b'],
    imageFamily: 'my-image-family',
    machineType: 'n2-standard-2',
    subnetwork: 'default',
    disableExternalIp: true,

    serviceAccount: 'service-account',

    diskType: 'pd-ssd',
    diskSizeGb: 75,
    ...props,
  });
};

describe('gcp', () => {
  describe('getBuildkiteConfig', () => {
    it('should generate the correct config', () => {
      const agentConfig = mockGcpAgentConfig();

      let config = getBuildkiteConfig(agentConfig);
      // hash is pretty unstable, so let's just replace it with something static
      config = config.replace(/,hash=[0-9a-z]+/, ',hash=hash');

      expect(config).toMatchInlineSnapshot(`
        "name=\\"%hostname\\"
        build-path=\\"/var/lib/buildkite-agent/builds\\"
        tags=\\"queue=test-queue,hash=hash,agent-manager=kibana\\""
      `);
    });

    it('should generate the correct config when spot is enabled', () => {
      const agentConfig = mockGcpAgentConfig({ spot: true });

      let config = getBuildkiteConfig(agentConfig);
      // hash is pretty unstable, so let's just replace it with something static
      config = config.replace(/,hash=[0-9a-z]+/, ',hash=hash');

      expect(config).toMatchInlineSnapshot(`
        "name=\\"%hostname\\"
        build-path=\\"/var/lib/buildkite-agent/builds\\"
        tags=\\"queue=test-queue,hash=hash,agent-manager=kibana,spot=true\\""
      `);
    });
  });
});
